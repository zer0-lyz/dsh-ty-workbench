# -*- coding: utf-8 -*-
"""车辆权证识别与归档（个人工作台 · 车辆评估模块宿主侧执行器）

子命令：
  companies --root <项目根>
  scan      --root ... [--company 公司目录名] [--source 指定资料目录]
  run       --root ... --company 公司目录名 [--source ...] [--limit N] [--no-ocr] [--engine auto|baidu|mineru]
  ocr       [--engine auto|baidu|mineru] [--ak KEY] [--sk SECRET] [--check] [--test 图片路径]  识别引擎设置/自检
  report    --root ... --company 公司目录名
  stage     --root ... --company 公司目录名 [--out 目录]   整理待上传副本（.doc 转 PDF）

约定：
- 源资料：公司目录下的 pdf/doc/docx/图片/xlsx，名称不规范也收（可按 --source 指定子目录）；
- 目标：<公司>/固定资产/车辆/，重命名 <车牌><类型><原扩展名>，类型 ∈ 车辆行驶证/车辆登记证/里程；
- 识别：MinerU flash-extract（图片/扫描件带 --ocr），docx 先取正文，无正文则把内嵌图片逐张 OCR；
- 里程：优先取 Excel 里程表（车牌→公里数），其次取权证正文里的里程；
- 记录：<目标>/_vehicle_index.json；report 用它生成 车辆权证信息表.xlsx。
输出：stdout 逐行 JSON。
"""
import sys, os, json, re, hashlib, shutil, zipfile, subprocess, tempfile, datetime, time, base64
import urllib.parse, urllib.request, urllib.error

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp'}
DOC_EXT = {'.pdf', '.doc', '.docx'}
SHEET_EXT = {'.xlsx', '.xls'}
ALL_EXT = IMAGE_EXT | DOC_EXT | SHEET_EXT

PLATE_CHAR = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼'
PLATE_RE = re.compile('[' + PLATE_CHAR + r'][A-Z][A-Z0-9]{4,6}')
VIN_RE = re.compile(r'([A-HJ-NPR-Z0-9]{17})')

# 权证里出现的字段标签（顺序有意义：值 = 本标签之后、下一个标签之前）
LABELS = ['号牌号码', '号牌号', '车辆类型', '所有人', '住 所', '住所', '使用性质', '品牌型号',
          '车辆识别代号', '发动机号码', '发动机号', '注册日期', '发证日期', '核定载人数',
          '总质量', '整备质量', '外廓尺寸', '检验有效期至', '登记证书编号', '登记机关',
          '登记日期', '转移登记', '抵押登记']
LATIN_NOISE = ['Vehicle License', 'VehicleType', 'Vehicle Type', 'Plate No', 'Owner', 'Address',
               'Use Character', 'UseCharacter', 'Model', 'VIN', 'Engine No', 'EngineNo',
               'Register Date', 'Issue Date', 'Approved Passenger', 'Gross Mass', 'Unladen Mass',
               'Dimension', 'Inspect Record', '中华人民共和国机动车行驶证', '中华人民共和国机动车登记证书']

VEH_KEY = re.compile(r'车辆|行驶证|驾驶证|登记证|权证|里程|行驶')
SKIP_KEY = re.compile(r'营业执照|章程|工商|审计|工资|对账单|纳税|在建工程|年终奖|决算|凭证|账簿|财务|发票|合同|评估报告|股权|验资')

TYPE_KEYS = {
    '车辆登记证': ['机动车登记证书', '登记证书编号', '登记机关', '转移登记', '抵押登记', '登记日期'],
    '车辆行驶证': ['行驶证', '号牌号码', '车辆识别代号', '注册日期', '发证日期', '使用性质', '核定载人数'],
    '里程': ['里程', '公里数', '行驶里程', '仪表', 'odometer'],
}
TYPE_ORDER = ['车辆登记证', '车辆行驶证', '里程']
# 文件名一看就不是权证的（协议/纪要/交接单…）；名字里带权证字样的除外
SKIP_NAME = re.compile(r'协议|合同|纪要|会议|交接单|验收单|通知|申请|审批|报销|发票|盘点表|清单')
CERT_NAME = re.compile(r'行驶证|登记证书|登记证')


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ---------------- 路径 ----------------

def find_base(root):
    """root 下真正装公司目录的 03资产基础法；找不到返回 None。"""
    root = os.path.abspath(root)
    if os.path.basename(root) == '03资产基础法':
        return root if os.path.isdir(root) else None
    for cand in (os.path.join(root, '02现场资料', '企业提供资料', '03资产基础法'),
                 os.path.join(root, '企业提供资料', '03资产基础法'),
                 os.path.join(root, '03资产基础法')):
        if os.path.isdir(cand):
            return cand
    return None


def discover_projects(root):
    """root 本身不是项目根时，在它下一层找含 03资产基础法 的项目文件夹。"""
    root = os.path.abspath(root)
    out = []
    if not os.path.isdir(root):
        return out
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return out
    for name in names:
        if name.startswith('.') or name.startswith('_'):
            continue
        p = os.path.join(root, name)
        if not os.path.isdir(p):
            continue
        b = find_base(p)
        if b and os.path.abspath(b) != root:
            out.append({'name': name, 'dir': p, 'base': b})
    return out


def base_dir(root):
    root = os.path.abspath(root)
    b = find_base(root)
    if b:
        return b
    projs = discover_projects(root)
    if len(projs) == 1:
        return projs[0]['base']
    return root


def list_companies(root):
    base = find_base(root)
    if base is None:
        projs = discover_projects(root)
        if len(projs) == 1:
            base = projs[0]['base']
        else:
            return []
    out = []
    if not os.path.isdir(base):
        return out
    for name in sorted(os.listdir(base)):
        p = os.path.join(base, name)
        if not os.path.isdir(p) or name.startswith('.') or not re.match(r'^\d{2}', name):
            continue
        out.append({'name': name, 'dir': p, 'target': os.path.join(p, '固定资产', '车辆'), 'kind': 'company'})
    return out


def do_companies(root):
    """列出待处理公司；root 给到项目集合目录（如 00项目ing）时回传项目列表让界面选。"""
    root = os.path.abspath(root)
    base = find_base(root)
    if base:
        emit(event='companies', mode='base', root=root, base=base, companies=list_companies(root))
        return
    projs = discover_projects(root)
    if len(projs) == 1:
        emit(event='companies', mode='auto', root=root, base=projs[0]['base'], project=projs[0]['dir'],
             companies=list_companies(projs[0]['dir']))
        return
    if projs:
        emit(event='companies', mode='projects', root=root, base=root,
             projects=[{'name': p['name'], 'dir': p['dir']} for p in projs],
             companies=[{'name': p['name'], 'dir': p['dir'], 'target': '', 'kind': 'project'} for p in projs])
        return
    emit(event='companies', mode='none', root=root, base=root, companies=[],
         msg='这个目录下没有找到 02现场资料/企业提供资料/03资产基础法，请选到具体项目文件夹')


def walk_sources(company_dir, source=None):
    """候选资料；返回 [(path, is_vehicle_folder)]"""
    skip_dirs = {'固定资产', '_markdown', '_md_cache', '.workbuddy', '_work', '__pycache__', 'node_modules'}
    out = []
    roots = [source] if source and os.path.isdir(source) else [company_dir]
    for r in roots:
        for dp, dns, fns in os.walk(r):
            dns[:] = [d for d in dns if d not in skip_dirs and not d.startswith('_') and not d.startswith('.')]
            for fn in fns:
                if fn.startswith('~$'):
                    continue
                ext = os.path.splitext(fn)[1].lower()
                if ext not in ALL_EXT:
                    continue
                rel = os.path.relpath(dp, company_dir)
                in_veh = bool(VEH_KEY.search(rel))
                out.append((os.path.join(dp, fn), in_veh))
    out.sort(key=lambda x: x[0])
    return out


def pick_sources(company_dir, source=None):
    """优先只处理车辆相关目录；一个都没有才回退到全公司。"""
    items = walk_sources(company_dir, source)
    veh = [p for p, v in items if v]
    if veh:
        return veh
    return [p for p, _ in items]


def has_skip_component(path, company_dir):
    rel = os.path.relpath(path, company_dir)
    for part in rel.split(os.sep)[:-1]:
        if SKIP_KEY.search(part) and not VEH_KEY.search(part):
            return True
    return False


def plate_from_name(name):
    m = PLATE_RE.search(nfkc(name).upper())
    return m.group(0) if m else ''


# ---------------- 文本理解 ----------------

def nfkc(s):
    try:
        import unicodedata
        return unicodedata.normalize('NFKC', s or '')
    except Exception:
        return s or ''


def clean_md(text):
    t = nfkc(text or '')
    t = re.sub(r'</?t[dhr][^>]*>', ' ', t)
    t = re.sub(r'</?table[^>]*>', ' ', t)
    t = re.sub(r'<!--.*?-->', ' ', t)
    t = re.sub(r'!\[\]\([^)]*\)', ' ', t)
    t = re.sub(r'[ \t]+', ' ', t)
    return t


def strip_latin(t):
    for w in LATIN_NOISE:
        t = t.replace(w, ' ')
    t = re.sub(r'[A-Za-z]{3,}(?=[\u4e00-\u9fa5])', ' ', t)
    t = re.sub(r'\s{2,}', ' ', t)
    return t


def label_positions(t):
    """返回按出现顺序排好的 [(pos, end, label)]。长标签优先匹配，避免「号牌号」抢「号牌号码」。"""
    hits = []
    for lab in sorted(LABELS, key=len, reverse=True):
        for m in re.finditer(re.escape(lab), t):
            hits.append((m.start(), m.end(), lab))
    hits.sort()
    # 去掉被更长标签覆盖的短标签
    kept = []
    for pos, end, lab in hits:
        if any(kp <= pos and end <= ke and (ke - kp) > (end - pos) for kp, ke, _kl in hits):
            continue
        kept.append((pos, end, lab))
    return kept


def segment_values(t):
    """把文本切成 标签 -> 值。值截止到下一个标签出现处。"""
    out = {}
    hits = label_positions(t)
    for i, (pos, end, lab) in enumerate(hits):
        stop = hits[i + 1][0] if i + 1 < len(hits) else min(len(t), end + 60)
        val = t[end:stop].strip(' :：|·、\t')
        val = re.sub(r'^[A-Za-z0-9.]{1,4}\s+', '', val)  # OCR 常把英文尾巴粘在值前面
        val = re.sub(r'\s+', ' ', val).strip()
        key = lab.replace(' ', '')
        if val and not out.get(key):
            out[key] = val
    return out


def parse_digits_date(raw):
    """把 'e2025-1.1-19.ueDa2025-11-1.9'、'022-11-17' 这类脏串还原成 YYYY-MM-DD。"""
    s = ''.join(re.findall(r'\d', raw or ''))
    for cand in (s, '2' + s, '20' + s):
        for m in re.finditer(r'(20\d{2})(\d{2})(\d{2})', cand):
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if _valid_date(y, mo, d):
                return '%04d-%02d-%02d' % (y, mo, d)
    return ''


def find_date_near(t, label, span=50):
    i = t.find(label)
    if i < 0:
        return ''
    seg = t[i + len(label): i + len(label) + span]
    return parse_digits_date(seg)


def collapse_cjk_spaces(t):
    """OCR 常把中文标签拆成「所 有 人」，把夹在两个汉字之间的空格消掉，其余保留。"""
    prev = None
    while prev != t:
        prev = t
        t = re.sub(r'([\u4e00-\u9fa5]) +([\u4e00-\u9fa5])', r'\1\2', t)
    return t


USE_RE = re.compile(r'(非营运|营转非|公路客运|公交客运|出租客运|旅游客运|货运|租赁|营运|教练|警用|危险品)')
VTYPE_RE = re.compile(r'((?:重型|中型|轻型|小型|微型|大型)[\u4e00-\u9fa5]{0,10}?(?:专项作业车|普通客车|多用途货车|载货汽车|半挂车|全挂车|作业车|客车|货车|轿车|越野车|挂车))')
MODEL_RE = re.compile(r'([\u4e00-\u9fa5]{1,5}牌\s?[A-Z0-9][A-Z0-9\-]{1,20}(?:[ ]\d[A-Z0-9\-]{0,14})*)')
BRAND_JUNK = ['非营运', '营运', '品牌型号', '型号', '性质', '品牌', '牌', '运', '型']
CANON_VTYPE = ['重型非载货专项作业车', '中型非载货专项作业车', '轻型非载货专项作业车',
               '重型载货专项作业车', '中型载货专项作业车', '轻型载货专项作业车',
               '重型载货汽车', '中型普通客车', '小型普通客车', '小型轿车', '小型越野客车',
               '轻型多用途货车', '中型多用途货车', '重型半挂牵引车', '轻型厢式货车']
NOISE_WORD = re.compile(r'(?<![A-Za-z0-9])[A-Za-z]{2,}(?![A-Za-z0-9])')
VIN_ANCHOR = re.compile(r'(?<![A-Z0-9])([A-HJ-NPR-Z0-9]{17})(?![A-Z0-9])')
OWNER_JUNK = set('所 有 人 住 址 车 辆 类 型 使 用 性 质 名 称 户'.split())
DATE_TOKEN = re.compile(r'(\d{2,4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})')
CN_NOW = datetime.date.today().year


def _valid_date(y, mo, d):
    return 1980 <= y <= CN_NOW + 2 and 1 <= mo <= 12 and 1 <= d <= 31


def _clean_value(v, cut_words=(), maxlen=40):
    v = NOISE_WORD.sub(' ', v or '')
    for w in cut_words:
        v = re.split(w, v)[0]
    v = re.sub(r'[\|·<>/\\]+', ' ', v)
    v = re.sub(r'\s{2,}', ' ', v).strip(' :：、,，.。-_')
    return v[:maxlen].strip()


def _ownername_from_text(t):
    """从「...有限公司」出现处向前回溯到最近的省市县区，得到单位全称。"""
    for m in re.finditer(r'(?:集团有限公司|有限责任公司|有限公司)', t):
        end = m.end()
        span = t[max(0, end - 44):end]
        idx = -1
        for ch in '省市区县':
            k = span.rfind(ch)
            if k > idx:
                idx = k
        name = span[max(0, idx - 2):] if idx >= 2 else span[-16:]
        tail = t[end:end + 5]
        name += re.match(r'(分公司|管理处|管理所|服务区)?', tail).group(0)
        name = name.strip()
        while name and name[0] in OWNER_JUNK:
            name = name[1:]
        name = re.sub(r'^(?:浙江省|省|市|县|区)+', '', name) if len(name) > 12 else name
        if 6 <= len(name) <= 44 and ('公司' in name or '单位' in name):
            return name
    return ''


def _vtype_from(t, plate=''):
    m = VTYPE_RE.search(t)
    if not m:
        return ''
    v = m.group(1)
    if plate:
        v = v.replace(plate, '')
    return v[:20]


def _model_from(t):
    for m in MODEL_RE.finditer(t):
        brand = m.group(1)
        for j in BRAND_JUNK:
            while brand.startswith(j) and len(brand) > len(j) + 3:
                brand = brand[len(j):]
        while len(brand) > 4 and brand[0] in '牌号型质性营运':
            brand = brand[1:]
        if len(brand) >= 3 and '牌' in brand and re.search(r'[A-Z0-9]{3,}', brand):
            core = re.sub(r'\s+', '', brand)
            # 型号代码被空格断开时续接（如「SH66 01 A4DB-N」），单字符残渣（Use 的 U）不接
            rest = t[m.end():]
            while True:
                mm = re.match(r'\s{1,2}([A-Z0-9\-]{2,14})(?=\s|[^A-Za-z0-9]|$)', rest)
                if not mm:
                    break
                code = core.split('牌', 1)[-1]
                if len(code) + len(mm.group(1)) > 18:
                    break
                core = core + mm.group(1)
                rest = rest[mm.end():]
            return core[:60]
    return ''


def _vin_from(t):
    for m in VIN_ANCHOR.finditer(t.upper()):
        c = m.group(1)
        if any(ch.isdigit() for ch in c):  # 纯字母的多半是英文标题残渣
            return c
    return ''


def _date_from(t, label, span=60):
    i = t.find(label)
    if i >= 0:
        seg = t[i + len(label): i + len(label) + span]
        for m in DATE_TOKEN.finditer(seg):
            nxt = seg[m.end():m.end() + 1]
            if nxt and (nxt.isdigit() or nxt in '-./'):
                continue  # '2025-1.1-19' 这类带插入点的串交给数字还原
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if y < 100:
                y += 2000
            if _valid_date(y, mo, d):
                return '%04d-%02d-%02d' % (y, mo, d)
        v = parse_digits_date(seg)
        if v:
            return v
    return ''


def extract_fields(text, plate_hint=''):
    raw = collapse_cjk_spaces(clean_md(text))
    t = collapse_cjk_spaces(strip_latin(raw))
    seg = segment_values(t)
    fields = {}

    plates = PLATE_RE.findall(t.upper())
    plate = plates[0] if plates else plate_hint
    fields['号牌号码'] = plate

    vt = _vtype_from(t, plate)
    if not vt:
        vt = _clean_value(seg.get('车辆类型', ''), (r'所\s*有', r'使用性质', r'品牌型号', r'住\s*所', r'住\s*址'), 22)
        vt = re.sub(r'号牌|牌号|码|' + re.escape(plate), '', vt).strip()
    fields['车辆类型'] = vt

    owner = _ownername_from_text(t)
    if not owner:
        owner = _clean_value(seg.get('所有人', ''), (r'住\s*所', r'住\s*址', r'使用性质', r'品牌型号'), 44)
        while owner and owner[0] in OWNER_JUNK:
            owner = owner[1:]
    fields['所有人'] = owner[:44]

    if '非营运' in t:
        use = '非营运'
    elif re.search(r'使用性(?!质)[^非]{0,3}营运', t):
        use = '非营运'          # OCR 把「非」认丢了（如「使用性雕营运」）
    else:
        mu = USE_RE.search(t)
        use = mu.group(1) if mu else _clean_value(seg.get('使用性质', ''), (r'品牌型号', r'车辆识别'), 8)
    fields['使用性质'] = use[:12]

    model = _model_from(t)
    if not model:
        model = _clean_value(seg.get('品牌型号', ''),
                             (r'车辆识别', r'发动机', r'注册日期', r'发证日期', r'浙江省', r'住\s*址',
                              r'住\s*所', r'非营运', r'营运', r'检验'), 40)
    model = re.sub(r'\s+', '', model)
    vin_in_model = re.search(r'[A-HJ-NPR-Z0-9]{17}', model)
    if vin_in_model and vin_in_model.start() > 0:
        model = model[:vin_in_model.start()]      # 型号后面粘上了 VIN，截掉
    if '牌' in model:
        head, tail = model.split('牌', 1)
        model = head + '牌' + tail[:18]
    fields['品牌型号'] = model[:24]

    fields['车辆识别代号'] = _vin_from(t)

    reg = _date_from(t, '注册日期')
    iss = _date_from(t, '发证日期')
    if not reg:
        for m in DATE_TOKEN.finditer(t):
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if y < 100:
                y += 2000
            if _valid_date(y, mo, d):
                reg = '%04d-%02d-%02d' % (y, mo, d)
                break
    if not iss:
        iss = reg
    fields['注册日期'] = reg
    fields['发证日期'] = iss

    km = ''
    m4 = re.search(r'(?:里程|公里数|行驶里程)[^\d]{0,8}(\d{2,7})', t)
    if m4:
        km = m4.group(1)
    fields['里程'] = km
    return fields


def classify(text, name, ext):
    if ext in SHEET_EXT:
        return '里程', {}
    t = clean_md(text)
    scores = {}
    for typ, keys in TYPE_KEYS.items():
        scores[typ] = sum(1 for k in keys if k in t)
    if '机动车登记证书' in t or '登记证书编号' in t:
        scores['车辆登记证'] += 3
    if '号牌号码' in t and '车辆识别代号' in t:
        scores['车辆行驶证'] += 2
    if '核定载人数' in t or '检验有效期' in t:
        scores['车辆行驶证'] += 1
    if scores['车辆行驶证'] == 0 and scores['车辆登记证'] == 0:
        if '登记证' in name and '行驶证' not in name:
            return '车辆登记证', scores
        return '车辆行驶证', scores
    best = max(TYPE_ORDER, key=lambda k: (scores.get(k, 0), -TYPE_ORDER.index(k)))
    return best, scores


def looks_like_cert(text, name):
    """正文里有没有权证特征；没有就别当归档（设备交接单、验收单、会议纪要之类）。"""
    t = clean_md(text)
    if re.search(r'行驶证|登记证书|号牌号码|车辆识别代号|注册日期|发证日期', t):
        return True
    return bool(re.search(r'行驶证|登记证', name or ''))


# ---------------- 转换 ----------------

def run(cmd, timeout=300, cwd=None):
    try:
        p = subprocess.run(cmd, capture_output=True, cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError('命令超时（%ss）' % timeout)
    return (p.returncode,
            (p.stdout or b'').decode('utf-8', 'replace'),
            (p.stderr or b'').decode('utf-8', 'replace'))


def find_mineru():
    env = os.environ.get('DSH_WORKBENCH_MINERU')
    cands = [env] if env else []
    cands += [os.path.expanduser('~/AppData/Roaming/npm/mineru-open-api.cmd'),
              shutil.which('mineru') or '', shutil.which('mineru-open-api') or '']
    for c in cands:
        if c and os.path.exists(c):
            return c
    return ''


MINERU = find_mineru()


def mineru_md(path):
    if not MINERU:
        raise RuntimeError('没找到 mineru 命令')
    ext = os.path.splitext(path)[1].lower()
    args = [MINERU, 'flash-extract', path, '--language', 'ch']
    if ext in IMAGE_EXT or ext == '.pdf':
        args.append('--ocr')
    code, out, err = run(args)
    if code != 0 and not out.strip():
        args2 = [a for a in args if a != '--ocr']
        code, out, err = run(args2)
    if not out.strip():
        raise RuntimeError((err or 'mineru 无输出').strip()[:200])
    lines = [ln for ln in out.splitlines()
             if ln.strip() and not ln.startswith('Thinking') and ln.strip() != 'Done']
    usage_bump('mineru_light')
    return "\n".join(lines).strip()


# ---------------- 百度智能云 OCR（行驶证识别） ----------------
# 接口：POST https://aip.baidubce.com/rest/2.0/ocr/v1/vehicle_license?access_token=...
#      Content-Type: application/x-www-form-urlencoded，body: image=<base64+urlencode>
#      可选 vehicle_license_side=front|back（正页/副页）、detect_direction=true、unified=true
# 与 MinerU 相比：字段级结构化（号牌号码/车辆类型/所有人/品牌型号/车辆识别代号/注册日期…），
# 不会把标签和值粘连，也基本不掉字，因此作为首选；MinerU 保留为无密钥时的兜底。

OCR_CFG_FILE = os.path.expanduser('~/.dsh/workbench-vehicle-ocr.json')
BAIDU_TOKEN_FILE = os.path.expanduser('~/.dsh/baidu-ocr-token.json')
BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token'
BAIDU_LICENSE_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/vehicle_license'
BAIDU_ACC_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic'

# 识别字段 → 底稿字段（同名直取；日期统一成 YYYY-MM-DD）
BAIDU_MAP = ['号牌号码', '车辆类型', '所有人', '使用性质', '品牌型号', '车辆识别代号',
             '注册日期', '发证日期', '发动机号码', '核定载人数', '总质量', '整备质量',
             '外廓尺寸', '检验有效期至', '登记证书编号', '登记机关', '登记日期']
DATE_FIELDS = ('注册日期', '发证日期', '登记日期', '检验有效期至')


def _read_ocr_file():
    try:
        with open(OCR_CFG_FILE, encoding='utf-8') as f:
            d = json.load(f) or {}
        if isinstance(d, dict):
            return d
    except Exception:
        pass
    return {}


def load_ocr_cfg():
    """识别配置：{engine, baidu:{ak,sk}, mineru:{token,model}, limits:{...}}；环境变量优先。"""
    raw = _read_ocr_file()
    b = raw.get('baidu') if isinstance(raw.get('baidu'), dict) else {}
    m = raw.get('mineru') if isinstance(raw.get('mineru'), dict) else {}
    lim = raw.get('limits') if isinstance(raw.get('limits'), dict) else {}
    cfg = {'engine': (raw.get('engine') or 'auto'),
           'baidu': {'ak': b.get('ak') or '', 'sk': b.get('sk') or ''},
           'mineru': {'token': m.get('token') or '', 'model': m.get('model') or 'vlm'},
           'limits': lim}
    if os.environ.get('DSH_BAIDU_OCR_AK'):
        cfg['baidu']['ak'] = os.environ['DSH_BAIDU_OCR_AK']
    if os.environ.get('DSH_BAIDU_OCR_SK'):
        cfg['baidu']['sk'] = os.environ['DSH_BAIDU_OCR_SK']
    if os.environ.get('DSH_MINERU_TOKEN'):
        cfg['mineru']['token'] = os.environ['DSH_MINERU_TOKEN']
    if os.environ.get('DSH_MINERU_MODEL'):
        cfg['mineru']['model'] = os.environ['DSH_MINERU_MODEL']
    if os.environ.get('DSH_VEHICLE_OCR_ENGINE'):
        cfg['engine'] = os.environ['DSH_VEHICLE_OCR_ENGINE']
    return cfg


def save_ocr_cfg(engine=None, ak=None, sk=None, mineru_token=None, mineru_model=None, limits=None):
    raw = _read_ocr_file()
    b = raw.get('baidu') if isinstance(raw.get('baidu'), dict) else {}
    m = raw.get('mineru') if isinstance(raw.get('mineru'), dict) else {}
    lim = raw.get('limits') if isinstance(raw.get('limits'), dict) else {}
    if limits:
        lim.update({k: int(v) for k, v in limits.items() if str(v).isdigit()})
    out = {'engine': (engine or raw.get('engine') or 'auto'),
           'baidu': {'ak': (ak if ak is not None and str(ak).strip() else (b.get('ak') or '')),
                     'sk': (sk if sk is not None and str(sk).strip() else (b.get('sk') or ''))},
           'mineru': {'token': (mineru_token if mineru_token is not None and str(mineru_token).strip() else (m.get('token') or '')),
                      'model': (mineru_model if mineru_model is not None and str(mineru_model).strip() else (m.get('model') or 'vlm'))},
           'limits': lim}
    d = os.path.dirname(OCR_CFG_FILE)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = OCR_CFG_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OCR_CFG_FILE)
    return out


def mask_key(s):
    s = s or ''
    if len(s) <= 8:
        return s[:2] + '***' if s else ''
    return s[:4] + '***' + s[-4:]


def resolve_engine(engine=None):
    """auto → 有百度 AK/SK 用 baidu；否则有 mineru token 用 mineru-pro（精准），都没有用 mineru（轻量）。"""
    raw = engine or load_ocr_cfg().get('engine') or 'auto'
    raw = str(raw).strip().lower().replace('_', '-')
    if raw in ('mineru-pro', 'pro', 'precise', 'precision'):
        return 'mineru-pro'
    if raw == 'auto':
        c = load_ocr_cfg()
        if c['baidu']['ak'] and c['baidu']['sk']:
            return 'baidu'
        return 'mineru-pro' if c['mineru']['token'] else 'mineru'
    return raw if raw in ('baidu', 'mineru') else 'mineru'


# ---------------- 用量统计（本地记账） ----------------
# 百度行驶证识别：每月免费 1000 次；MinerU 轻量（flash-extract）：每天 5000 份；
# MinerU 精准（extract）：按页占用每日额度，同样在这里记份数/页数。
# 只记本机调用（别处/网页版用掉的看不到），额度可在配置文件里改。

USAGE_FILE = os.path.expanduser('~/.dsh/workbench-vehicle-usage.json')
DEFAULT_LIMITS = {'baidu_month': 1000, 'mineru_day': 5000}


def _period(tag):
    return time.strftime('%Y-%m') if tag == 'month' else time.strftime('%Y-%m-%d')


def load_usage():
    u = {}
    try:
        with open(USAGE_FILE, encoding='utf-8') as f:
            u = json.load(f) or {}
    except Exception:
        u = {}
    if not isinstance(u, dict):
        u = {}
    lim = dict(DEFAULT_LIMITS)
    if isinstance(u.get('limits'), dict):
        for k, v in u['limits'].items():
            if str(v).strip().isdigit():
                lim[k] = int(v)
    u['limits'] = lim
    for key, tag in (('baidu', 'month'), ('mineru_light', 'day'), ('mineru_pro', 'day')):
        d = u.get(key) if isinstance(u.get(key), dict) else {}
        cur = _period(tag)
        if d.get(tag) != cur:
            d = {tag: cur, 'count': 0, 'pages': 0, 'total': int(d.get('total') or 0)}
        d['count'] = int(d.get('count') or 0)
        d['pages'] = int(d.get('pages') or 0)
        d['total'] = int(d.get('total') or 0)
        d[tag] = cur
        u[key] = d
    return u


def save_usage(u):
    d = os.path.dirname(USAGE_FILE)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = USAGE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(u, f, ensure_ascii=False, indent=1)
    os.replace(tmp, USAGE_FILE)


def usage_bump(kind, n=1, pages=0):
    u = load_usage()
    d = u.get(kind) or {}
    d['count'] = int(d.get('count') or 0) + n
    if pages:
        d['pages'] = int(d.get('pages') or 0) + int(pages)
    d['total'] = int(d.get('total') or 0) + n
    d['at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    u[kind] = d
    save_usage(u)
    return usage_summary()


def usage_summary():
    u = load_usage()
    lim = u['limits']

    def pack(key, tag, limit):
        d = u.get(key) or {}
        used = int(d.get('count') or 0)
        limit = int(limit or 0)
        return {'period': d.get(tag) or _period(tag), 'used': used, 'limit': limit,
                'left': max(0, limit - used) if limit else None,
                'pages': int(d.get('pages') or 0), 'total': int(d.get('total') or 0)}

    return {'baidu': pack('baidu', 'month', lim.get('baidu_month')),
            'mineru': pack('mineru_light', 'day', lim.get('mineru_day')),
            'mineruPro': pack('mineru_pro', 'day', 0)}


def usage_line():
    s = usage_summary()
    b, m, p = s['baidu'], s['mineru'], s['mineruPro']
    def txt(x, unit, page=False):
        head = '%d/%d %s' % (x['used'], x['limit'], unit) if x['limit'] else '%d %s' % (x['used'], unit)
        return head + ('（%s）' % x['period'])
    return '百度 %s · mineru轻量 %s · mineru精准 %d 份/%d 页' % (
        txt(b, '次/月'), txt(m, '份/天'), p['used'], p['pages'])


def pdf_pages(path):
    try:
        import fitz
        d = fitz.open(path)
        n = d.page_count
        d.close()
        return int(n or 1)
    except Exception:
        return 1


def mineru_precise_md(path):
    """MinerU 精准解析（/api/v4/extract/task，需 token）：表格/公式/多格式，适合登记证、复杂扫描件。"""
    if not MINERU:
        raise RuntimeError('没找到 mineru 命令')
    cfg = load_ocr_cfg()
    tok = (cfg.get('mineru') or {}).get('token') or ''
    if not tok:
        raise RuntimeError('没配 mineru 精准解析 token：vehicle_cert.py ocr --mineru-token <token>')
    model = (cfg.get('mineru') or {}).get('model') or 'vlm'
    ext = os.path.splitext(path)[1].lower()
    outdir = tempfile.mkdtemp(prefix='mpro_')
    try:
        args = [MINERU, '--token', tok, 'extract', path, '--model', model, '--language', 'ch', '-o', outdir]
        if ext in IMAGE_EXT or ext == '.pdf':
            args.append('--ocr')
        code, out, err = run(args, timeout=900)
        mds = []
        for dp, _dns, fns in os.walk(outdir):
            for fn in sorted(fns):
                if fn.lower().endswith('.md'):
                    with open(os.path.join(dp, fn), encoding='utf-8') as f:
                        mds.append(f.read())
        if not mds:
            raise RuntimeError((err or out or 'mineru 精准解析无输出').strip()[:200])
        usage_bump('mineru_pro', pages=pdf_pages(path) if ext == '.pdf' else 1)
        return '\n\n'.join(mds).strip()
    finally:
        shutil.rmtree(outdir, ignore_errors=True)


def _post_json(url, data, headers=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            return json.loads(body)
        except Exception:
            raise RuntimeError('HTTP %s %s' % (e.code, body[:200]))
    except urllib.error.URLError as e:
        raise RuntimeError('连不上百度接口：%s' % e)


def baidu_token(ak='', sk='', force=False):
    if not (ak and sk):
        c = load_ocr_cfg()
        ak = ak or c['baidu']['ak']
        sk = sk or c['baidu']['sk']
    if not (ak and sk):
        raise RuntimeError('未配置百度 OCR 的 API Key / Secret Key（工作台 → 车辆评估 → 识别引擎）')
    if not force:
        try:
            with open(BAIDU_TOKEN_FILE, encoding='utf-8') as f:
                t = json.load(f) or {}
            if t.get('ak') == ak and t.get('token') and float(t.get('exp') or 0) > time.time() + 600:
                return t['token']
        except Exception:
            pass
    url = BAIDU_TOKEN_URL + '?' + urllib.parse.urlencode(
        {'grant_type': 'client_credentials', 'client_id': ak, 'client_secret': sk})
    d = _post_json(url, b'', {}, 30)
    if not d.get('access_token'):
        raise RuntimeError('百度 token 获取失败：%s %s' % (d.get('error') or '', d.get('error_description') or ''))
    try:
        os.makedirs(os.path.dirname(BAIDU_TOKEN_FILE), exist_ok=True)
        with open(BAIDU_TOKEN_FILE, 'w', encoding='utf-8') as f:
            json.dump({'ak': ak, 'token': d['access_token'],
                       'exp': time.time() + float(d.get('expires_in') or 2592000)}, f)
    except Exception:
        pass
    return d['access_token']


def baidu_license(data, side='front', ak='', sk='', retry=True):
    """行驶证识别。返回原始 JSON（含 error_code 时由调用方判断）。"""
    tk = baidu_token(ak, sk)
    body = urllib.parse.urlencode({
        'image': base64.b64encode(data).decode('ascii'),
        'detect_direction': 'true',
        'unified': 'true',
        'vehicle_license_side': side,
        'quality_warn': 'true',
    }).encode()
    out = _post_json(BAIDU_LICENSE_URL + '?access_token=' + tk, body,
                     {'Content-Type': 'application/x-www-form-urlencoded'})
    if str(out.get('error_code') or '') not in ('110', '111'):
        usage_bump('baidu')
    if str(out.get('error_code') or '') in ('110', '111') and retry:
        baidu_token(ak, sk, force=True)
        return baidu_license(data, side, ak, sk, retry=False)
    return out


def _baidu_words(out):
    wr = out.get('words_result') or {}
    if not isinstance(wr, dict):
        return {}
    res = {}
    for k, v in wr.items():
        val = v.get('words') if isinstance(v, dict) else v
        if val not in (None, ''):
            res[str(k)] = str(val)
    return res


def baidu_license_words(data, side='auto', ak='', sk=''):
    """正页优先；正页模板不匹配时再试副页。返回 (words, 用到的面, 错误列表)。"""
    sides = [side] if side in ('front', 'back') else ['front', 'back']
    words, used, errs = {}, [], []
    for s in sides:
        out = baidu_license(data, s, ak, sk)
        code = str(out.get('error_code') or '')
        if code:
            errs.append('%s:%s %s' % (s, code, out.get('error_msg') or ''))
            continue
        used.append(s)
        for k, v in _baidu_words(out).items():
            if v and not words.get(k):
                words[k] = v
        if s == 'front' and words.get('号牌号码'):
            break
    return words, used, errs


def baidu_general_text(data, ak='', sk=''):
    """通用文字识别（高精度版）：登记证书、复印件、整页扫描这类不适用行驶证模板的图。"""
    tk = baidu_token(ak, sk)
    body = urllib.parse.urlencode({
        'image': base64.b64encode(data).decode('ascii'),
        'detect_direction': 'true',
        'paragraph': 'false',
    }).encode()
    out = _post_json(BAIDU_ACC_URL + '?access_token=' + tk, body,
                     {'Content-Type': 'application/x-www-form-urlencoded'})
    code = str(out.get('error_code') or '')
    if code not in ('110', '111'):
        usage_bump('baidu')
    if code:
        raise RuntimeError('百度通用OCR失败（%s）：%s' % (code, out.get('error_msg') or ''))
    lines = [(w.get('words') or '').strip() for w in (out.get('words_result') or [])]
    return '\n'.join([x for x in lines if x])


def _norm_bd_date(v):
    s = re.sub(r'[^0-9]', '', v or '')
    if len(s) == 8:
        y, mo, d = int(s[:4]), int(s[4:6]), int(s[6:8])
        if _valid_date(y, mo, d):
            return '%04d-%02d-%02d' % (y, mo, d)
    return parse_digits_date(v)


def baidu_fields(words, plate_hint=''):
    """把百度结构化结果直接映射成底稿字段（比正则解析准，优先采用）。"""
    f = {}
    for k in BAIDU_MAP:
        v = (words.get(k) or '').strip()
        if not v:
            continue
        if k in DATE_FIELDS:
            v = _norm_bd_date(v)
            if not v:
                continue
        if k == '号牌号码':
            v = nfkc(v).replace(' ', '')
            m = PLATE_RE.search(v)
            v = m.group(0) if m else (plate_hint or '')
            if not v:
                continue
        elif k == '车辆类型':
            m = VTYPE_RE.search(v)
            v = m.group(1) if m else v
        elif k == '品牌型号':
            v = re.sub(r'\s+', '', v)
        elif k == '车辆识别代号':
            m = VIN_ANCHOR.search(v.upper())
            v = m.group(1) if m else v
        f[k] = v
    return f


def baidu_md_text(words, note=''):
    """把结构化结果写成 label：value 文本，供存档、追溯，以及 refresh_fields 重新解析。"""
    order = ['号牌号码', '车辆类型', '所有人', '住址', '使用性质', '品牌型号', '车辆识别代号',
             '发动机号码', '注册日期', '发证日期', '发证单位', '核定载人数', '总质量', '整备质量',
             '外廓尺寸', '检验有效期至', '登记证书编号', '登记机关', '登记日期', '转移登记',
             '抵押登记', '状态', '强制报废期止', '车身颜色', '能源种类']
    lines = []
    for k in order:
        v = (words.get(k) or '').strip()
        if not v:
            continue
        if k in DATE_FIELDS:
            v = _norm_bd_date(v) or v
        lines.append(k + '：' + v)
    for k, v in words.items():
        if k not in order and str(v or '').strip():
            lines.append(k + '：' + str(v).strip())
    if note:
        lines.append(note)
    return '\n'.join(lines)


def _baidu_image_md(data, direct=None):
    words, used, errs = baidu_license_words(data)
    if words:
        if direct is not None:
            direct.update(baidu_fields(words))
        return baidu_md_text(words, '[百度行驶证识别 ' + '/'.join(used) + ']')
    txt = baidu_general_text(data)
    if txt.strip():
        return txt
    raise RuntimeError('百度 OCR 无结果：' + ('; '.join(errs) or '空'))


def ocr_image_md(path, cache_dir=None, engine=None, direct=None):
    """单张图片识别。engine=baidu 用百度，否则 MinerU；auto 时百度失败回退 MinerU。"""
    raw = str(engine or load_ocr_cfg().get('engine') or 'auto').lower()
    eng = resolve_engine(engine)
    with open(path, 'rb') as f:
        data = f.read()
    h = hashlib.sha1(data).hexdigest()
    cname = h + ('.baidu.md' if eng == 'baidu' else '.pro.md' if eng == 'mineru-pro' else '.md')
    cp = os.path.join(cache_dir, cname) if cache_dir else ''
    if cp and os.path.exists(cp):
        try:
            with open(cp, encoding='utf-8') as f:
                return f.read()
        except Exception:
            pass
    if eng == 'baidu':
        try:
            md = _baidu_image_md(data, direct)
        except Exception:
            if raw in ('baidu',):
                raise
            emit(event='log', msg='百度 OCR 失败，回退 MinerU：' + os.path.basename(path))
            md = mineru_md(path)
    elif eng == 'mineru-pro':
        try:
            md = mineru_precise_md(path)
        except Exception as e:
            if raw in ('mineru-pro', 'pro', 'precise', 'precision'):
                raise
            emit(event='log', msg='MinerU 精准解析失败，回退轻量：%s' % str(e)[:120])
            md = mineru_md(path)
    else:
        md = mineru_md(path)
    if cp and md:
        try:
            with open(cp, 'w', encoding='utf-8') as f:
                f.write(md[:100000])
        except Exception:
            pass
    return md


def pdf_ocr_md(path, direct=None):
    """PDF 逐页渲染成图，再走百度行驶证识别（正页/副页自动）。"""
    try:
        import fitz
    except Exception as e:
        raise RuntimeError('缺 PyMuPDF（pip install pymupdf）：%s' % e)
    doc = fitz.open(path)
    tmpd = tempfile.mkdtemp(prefix='vehpdf_')
    parts = []
    try:
        for i, page in enumerate(doc):
            p = os.path.join(tmpd, 'p%02d.jpg' % (i + 1))
            page.get_pixmap(dpi=200).save(p)
            try:
                with open(p, 'rb') as f:
                    parts.append(_baidu_image_md(f.read(), direct))
            except Exception as e:
                emit(event='log', msg='百度 OCR 第 %d 页失败：%s' % (i + 1, str(e)[:120]))
    finally:
        doc.close()
        shutil.rmtree(tmpd, ignore_errors=True)
    return '\n\n'.join([x for x in parts if x and x.strip()])


def docx_markdown(path, use_ocr=True, cache_dir=None, engine=None, direct=None):
    texts = []
    try:
        import docx
        d = docx.Document(path)
        for p in d.paragraphs:
            if p.text and p.text.strip():
                texts.append(p.text.strip())
        for t in d.tables:
            for row in t.rows:
                cells = [c.text.replace('\n', ' ').strip() for c in row.cells]
                if any(cells):
                    texts.append(' | '.join(cells))
    except Exception:
        pass
    body = "\n".join(texts).strip()
    with zipfile.ZipFile(path) as z:
        media = [n for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')]
    if not media:
        return body
    if len(body) >= 120 and not use_ocr:
        return body
    tmp = tempfile.mkdtemp(prefix='vehocr_')
    parts = [body] if body else []
    try:
        with zipfile.ZipFile(path) as z:
            for n in media:
                data = z.read(n)
                tgt = os.path.join(tmp, os.path.basename(n))
                with open(tgt, 'wb') as f:
                    f.write(data)
                try:
                    parts.append(ocr_image_md(tgt, cache_dir, engine, direct))
                except Exception:
                    parts.append('')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return "\n\n".join([p for p in parts if p and p.strip()])


def doc_to_docx(path):
    import win32com.client as win32
    tmpdir = tempfile.mkdtemp(prefix='vehdoc_')
    out = os.path.join(tmpdir, os.path.splitext(os.path.basename(path))[0] + '.docx')
    app = win32.DispatchEx('Word.Application')
    app.Visible = False
    app.DisplayAlerts = 0
    try:
        doc = app.Documents.Open(os.path.abspath(path))
        doc.SaveAs2(os.path.abspath(out), FileFormat=16)
        doc.Close(False)
    finally:
        try:
            app.Quit()
        except Exception:
            pass
    return out


def sheet_rows(path):
    rows = []
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True)
        for ws in wb.worksheets:
            for r in ws.iter_rows(values_only=True):
                cells = [nfkc('' if v is None else str(v)).strip() for v in r]
                if any(cells):
                    rows.append(cells)
        return rows
    except Exception:
        pass
    try:
        import xlrd
        bk = xlrd.open_workbook(path)
        for sh in bk.sheets():
            for i in range(sh.nrows):
                rows.append([str(c).strip() for c in sh.row_values(i)])
    except Exception as e:
        raise RuntimeError('读 Excel 失败：%s' % e)
    return rows


def sheet_markdown(path):
    return "\n".join(' | '.join(r) for r in sheet_rows(path)[:400])


def mileage_map(path):
    """从里程表里取 {车牌: 公里数}。表头可能是「车牌号码」「公里数」等。"""
    rows = sheet_rows(path)
    out = {}
    for r in rows:
        line = nfkc(' '.join(r)).upper()
        for plate in PLATE_RE.findall(line):
            nums = [c for c in r if re.fullmatch(r'\d{1,7}(\.\d+)?', c or '')]
            if nums:
                out.setdefault(plate, nums[-1])
    return out


def file_markdown(path, use_ocr=True, cache_dir=None, engine=None, direct=None):
    """把一份资料识别成文本。engine=baidu 时结构化字段会写进 direct（比正则解析准）。"""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.docx':
        return docx_markdown(path, use_ocr, cache_dir, engine, direct)
    if ext == '.doc':
        tmp = doc_to_docx(path)
        try:
            return docx_markdown(tmp, use_ocr, cache_dir, engine, direct)
        finally:
            shutil.rmtree(os.path.dirname(tmp), ignore_errors=True)
    if ext == '.pdf':
        eng = resolve_engine(engine)
        if eng == 'baidu':
            md = pdf_ocr_md(path, direct)
            if md.strip():
                return md
        elif eng == 'mineru-pro':
            try:
                return mineru_precise_md(path)
            except Exception as e:
                emit(event='log', msg='MinerU 精准解析失败，回退轻量：%s' % str(e)[:120])
        return mineru_md(path)
    if ext in IMAGE_EXT:
        return ocr_image_md(path, cache_dir, engine, direct)
    if ext in SHEET_EXT:
        return sheet_markdown(path)
    return ''


# ---------------- 归档 ----------------

BAD = re.compile(r'[\\/:*?"<>|]')


def safe(s):
    return BAD.sub('_', s or '')


def load_index(target):
    p = os.path.join(target, '_vehicle_index.json')
    if os.path.exists(p):
        try:
            with open(p, encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_index(target, idx):
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, '_vehicle_index.json'), 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)


def do_scan(root, company=None, source=None, limit=0):
    comps = list_companies(root)
    if company:
        comps = [c for c in comps if c['name'] == company]
    result = []
    for c in comps:
        files = pick_sources(c['dir'], source)
        items = []
        for f in files:
            if has_skip_component(f, c['dir']):
                continue
            items.append({'file': f, 'name': os.path.basename(f),
                          'ext': os.path.splitext(f)[1].lower(),
                          'plate': plate_from_name(os.path.basename(f)),
                          'size': os.path.getsize(f)})
            if limit and len(items) >= limit:
                break
        result.append({'company': c['name'], 'dir': c['dir'], 'target': c['target'],
                       'count': len(items), 'files': items})
    emit(event='scan', base=base_dir(root), companies=result)
    return result


def normalize_records(idx):
    """跨记录纠错：车辆类型用规范词库就近匹配；所有人用同公司众数修 OCR 掉字。"""
    import difflib
    owners = {}
    for rec in idx.values():
        o = (rec.get('fields') or {}).get('所有人') or ''
        if len(o) >= 10:
            owners[o] = owners.get(o, 0) + 1
    mode = max(owners, key=owners.get) if owners else ''
    fixed = 0
    for rec in idx.values():
        f = rec.setdefault('fields', {})
        vt = f.get('车辆类型') or ''
        if vt:
            best = max(CANON_VTYPE, key=lambda c: difflib.SequenceMatcher(None, vt, c).ratio())
            if difflib.SequenceMatcher(None, vt, best).ratio() >= 0.72:
                if vt != best:
                    f['车辆类型'] = best
                    fixed += 1
        o = f.get('所有人') or ''
        if mode and o != mode and (mode.endswith(o) or o in mode) and len(o) < len(mode):
            f['所有人'] = mode
            fixed += 1
    # 品牌名：少数记录多出 OCR 噪声字（如「招日产」）→ 收敛到同批多数品牌
    from collections import Counter
    brands = []
    for rec in idx.values():
        bm = (rec.get('fields') or {}).get('品牌型号') or ''
        if '牌' in bm:
            brands.append(bm.split('牌', 1)[0])
    cnt = Counter(brands)
    pool = [b for b, n in cnt.items() if n >= 2 and 2 <= len(b) <= 4]
    for rec in idx.values():
        f = rec.setdefault('fields', {})
        bm = f.get('品牌型号') or ''
        if '牌' not in bm:
            continue
        head, tail = bm.split('牌', 1)
        if not head or head in pool:
            continue
        for b in pool:
            if head != b and head.endswith(b):
                f['品牌型号'] = b + '牌' + tail
                fixed += 1
                break
    return fixed


def do_run(root, company, source=None, limit=0, use_ocr=True, engine=None):
    comps = [c for c in list_companies(root) if c['name'] == company]
    if not comps:
        raise RuntimeError('没找到公司目录：%s' % company)
    c = comps[0]
    target = c['target']
    md_dir = os.path.join(target, '_markdown')
    cache_dir = os.path.join(target, '_md_cache')
    for d in (target, md_dir, cache_dir):
        os.makedirs(d, exist_ok=True)
    idx = load_index(target)
    files = [f for f in pick_sources(c['dir'], source) if not has_skip_component(f, c['dir'])]
    if limit:
        files = files[:limit]
    emit(event='start', company=company, total=len(files), target=target)
    mileage = {}
    seen_hash = {}
    for n, f in enumerate(files, start=1):
        name = os.path.basename(f)
        ext = os.path.splitext(f)[1].lower()
        emit(event='progress', n=n, total=len(files), file=name)
        if ext in SHEET_EXT:
            try:
                m = mileage_map(f)
            except Exception as e:
                emit(event='file', file=name, status='error', msg=str(e)[:200])
                continue
            if m:
                mileage.update(m)
                emit(event='file', file=name, status='mileage', msg='读到 %d 辆车的公里数' % len(m), count=len(m))
            else:
                emit(event='file', file=name, status='skip', msg='Excel 里没读到车牌+公里数')
            for plate, km in m.items():
                key = plate + '|里程'
                rec = idx.get(key) or {}
                rec.update({'plate': plate, 'type': '里程',
                            'fields': {**(rec.get('fields') or {}), '号牌号码': plate, '里程': km},
                            'source': f, 'at': datetime.datetime.now().isoformat(timespec='seconds')})
                idx[key] = rec
            continue
        plate_hint = plate_from_name(name)
        if SKIP_NAME.search(name) and not CERT_NAME.search(name):
            emit(event='file', file=name, status='skip', plate=plate_hint, msg='文件名不像权证（协议/纪要/交接单等），未处理')
            continue
        try:
            with open(f, 'rb') as fh:
                fhash = hashlib.sha1(fh.read()).hexdigest()
        except Exception:
            fhash = ''
        if fhash and fhash in seen_hash:
            emit(event='file', file=name, status='skip', plate=plate_hint,
                 msg='与已处理文件内容相同：' + seen_hash[fhash])
            continue
        if fhash:
            seen_hash[fhash] = name
        direct = {}
        try:
            md = file_markdown(f, use_ocr, cache_dir, engine, direct)
        except Exception as e:
            emit(event='file', file=name, status='error', msg=str(e)[:200], plate=plate_hint)
            continue
        if not (md or '').strip():
            emit(event='file', file=name, status='skip', msg='没有识别到文字', plate=plate_hint)
            continue
        typ, scores = classify(md, name, ext)
        fields = extract_fields(md, plate_hint)
        # 百度结构化识别结果优先（它给的是字段，不是靠正则猜的）
        for _k, _v in (direct or {}).items():
            if _v:
                fields[_k] = _v
        # 既没有权证特征、也认不出车牌 → 不是权证（交接单/验收单/纪要）
        if not looks_like_cert(md, name) and not fields.get('号牌号码'):
            emit(event='file', file=name, status='skip', plate=plate_hint, mdLen=len(md),
                 msg='不像权证（无行驶证/号牌/车辆识别代号特征），未归档')
            with open(os.path.join(md_dir, safe(os.path.splitext(name)[0]) + '.md'), 'w', encoding='utf-8') as fh:
                fh.write(md[:200000])
            continue
        plate = fields.get('号牌号码') or ''
        if not plate:
            emit(event='file', file=name, status='skip', msg='认不出车牌号，未归档（md 已存 _markdown）', mdLen=len(md))
            with open(os.path.join(md_dir, safe(os.path.splitext(name)[0]) + '.md'), 'w', encoding='utf-8') as fh:
                fh.write(md[:200000])
            continue
        key = plate + '|' + typ
        prev = idx.get(key)
        if prev and prev.get('target') and os.path.exists(prev['target']):
            if (prev.get('mdLen') or 0) >= len(md):
                emit(event='file', file=name, status='dup', plate=plate, type=typ,
                     msg='已归档：' + os.path.basename(prev['target']))
                continue
        tname = safe(plate + typ + ext)
        tpath = os.path.join(target, tname)
        k = 1
        while os.path.exists(tpath) and (not prev or prev.get('target') != tpath):
            tname = safe(plate + typ + '_%d' % k + ext)
            tpath = os.path.join(target, tname)
            k += 1
        if prev and prev.get('target') and prev['target'] != tpath and os.path.exists(prev['target']):
            try:
                os.remove(prev['target'])
            except Exception:
                pass
        shutil.copy2(f, tpath)
        md_path = os.path.join(md_dir, os.path.splitext(tname)[0] + '.md')
        with open(md_path, 'w', encoding='utf-8') as fh:
            fh.write(md[:200000])
        rec = {'plate': plate, 'type': typ, 'source': f, 'fields': fields,
               'mdLen': len(md), 'scores': scores, 'target': tpath, 'targetName': tname,
               'md': md_path, 'at': datetime.datetime.now().isoformat(timespec='seconds')}
        idx[key] = rec
        emit(event='file', file=name, status='ok', plate=plate, type=typ, target=tname,
             fields=fields, mdLen=len(md))
    try:
        nfix = normalize_records(idx)
        if nfix:
            emit(event='log', msg='纠正字段 %d 处' % nfix)
    except Exception as e:
        emit(event='log', msg='字段纠错跳过：%s' % e)
    # 里程补进行驶证记录
    if mileage:
        for key, rec in list(idx.items()):
            plate = rec.get('plate') or ''
            if plate in mileage and (rec.get('fields') or {}).get('里程') != mileage[plate]:
                rec.setdefault('fields', {})['里程'] = mileage[plate]
        save_index(target, idx)
    save_index(target, idx)
    emit(event='done', target=target, count=len(idx),
         records=[{k: v for k, v in r.items() if k != 'md'} for r in idx.values()])
    return idx


# ---------------- 车牌规范化 ----------------

def plate_candidates(company_dir):
    """规范车牌候选：先取里程表/清单类 Excel 里的全部车牌，再取原始文件名里的车牌。"""
    plates = []
    files = pick_sources(company_dir)
    for f in files:
        if os.path.splitext(f)[1].lower() in SHEET_EXT:
            try:
                for r in sheet_rows(f):
                    for cell in r:
                        for pl in PLATE_RE.findall(nfkc(cell).upper()):
                            plates.append(pl)
            except Exception:
                pass
    for f in files:
        pl = plate_from_name(os.path.basename(f))
        if pl:
            plates.append(pl)
    uniq = []
    for x in plates:
        if x and x not in uniq:
            uniq.append(x)
    full = [x for x in uniq if len(x) >= 7] or uniq
    return full


def fix_plates(company_dir, target, idx):
    """把 OCR 认错的车牌就近对到规范车牌（差一个字符最常见：68385/68305、938YL/930YL、掉尾字母）。"""
    import difflib
    canon = plate_candidates(company_dir)
    if not canon:
        return []
    known = set(canon)
    fixes = []
    for key in list(idx.keys()):
        rec = idx[key] or {}
        plate = (rec.get('plate') or key.split('|')[0] or '').upper()
        typ = rec.get('type') or key.split('|')[-1]
        if not plate:
            continue
        if plate in known:
            rec['plate'] = plate
            continue
        best, bestr = '', 0.0
        for c in known:
            r = difflib.SequenceMatcher(None, plate, c).ratio()
            if r > bestr:
                bestr, best = r, c
        if not best or bestr < 0.84:
            continue
        nkey = best + '|' + typ
        rec['plate'] = best
        rec.setdefault('fields', {})['号牌号码'] = best
        old = rec.get('target') or ''
        ext = os.path.splitext(old)[1]
        if old and os.path.exists(old):
            nname = safe(best + typ + ext)
            npath = os.path.join(target, nname)
            k = 1
            while os.path.exists(npath) and os.path.abspath(npath) != os.path.abspath(old):
                nname = safe(best + typ + '_%d' % k + ext)
                npath = os.path.join(target, nname)
                k += 1
            try:
                os.replace(old, npath)
                rec['target'], rec['targetName'] = npath, os.path.basename(npath)
                oldmd = rec.get('md') or ''
                if oldmd and os.path.exists(oldmd):
                    nmd = os.path.join(os.path.dirname(oldmd), os.path.splitext(nname)[0] + '.md')
                    os.replace(oldmd, nmd)
                    rec['md'] = nmd
            except Exception:
                pass
        del idx[key]
        prev = idx.get(nkey)
        if prev and isinstance(prev, dict):
            pf = prev.setdefault('fields', {})
            for kk, vv in (rec.get('fields') or {}).items():
                if vv and not pf.get(kk):
                    pf[kk] = vv
            if (rec.get('mdLen') or 0) > (prev.get('mdLen') or 0):
                for kk in ('source', 'target', 'targetName', 'md', 'mdLen', 'at'):
                    if rec.get(kk):
                        prev[kk] = rec[kk]
        else:
            idx[nkey] = rec
        fixes.append({'from': plate, 'to': best, 'type': typ})
    return fixes


def refresh_fields(idx):
    """用已存的识别文本重跑字段提取（解析规则升级后可一键刷新，不必重新 OCR）。"""
    n = 0
    for rec in idx.values():
        md_path = rec.get('md') or ''
        if not md_path or not os.path.exists(md_path):
            continue
        try:
            with open(md_path, encoding='utf-8') as fh:
                md = fh.read()
        except Exception:
            continue
        if not md.strip():
            continue
        old = rec.get('fields') or {}
        new = extract_fields(md, rec.get('plate') or '')
        keep_km = old.get('里程')
        plate = rec.get('plate') or old.get('号牌号码') or new.get('号牌号码') or ''
        for k, v in old.items():
            if v and not new.get(k):
                new[k] = v
        if keep_km:
            new['里程'] = keep_km
        if plate:
            new['号牌号码'] = plate
        rec['fields'] = new
        n += 1
    return n


def do_fix(root, company):
    comps = [c for c in list_companies(root) if c['name'] == company]
    if not comps:
        raise RuntimeError('没找到公司目录：%s' % company)
    c = comps[0]
    idx = load_index(c['target'])
    if not idx:
        raise RuntimeError('还没有归档记录，先跑识别归档')
    try:
        nf = refresh_fields(idx)
        emit(event='log', msg='按现有识别文本刷新字段 %d 条' % nf)
    except Exception as e:
        emit(event='log', msg='刷新字段跳过：%s' % e)
    fixes = fix_plates(c['dir'], c['target'], idx)
    try:
        normalize_records(idx)
    except Exception:
        pass
    save_index(c['target'], idx)
    for f in fixes:
        emit(event='log', msg='车牌纠正 %s → %s（%s）' % (f['from'], f['to'], f['type']))
    emit(event='fix', count=len(fixes), fixes=fixes, total=len(idx))
    return fixes


# ---------------- Excel ----------------

# ---------------- 上传天源底稿 ----------------
# 天源「权证索引」弹窗只收 pdf/docx/xlsx/jpg/jpeg/png，.doc 必须先转 PDF；
# 顺带把文件名统一成「车牌+分类」，在天源里一眼能看出是哪辆车的什么证。

UPLOAD_EXT = {'.pdf', '.docx', '.xlsx', '.jpg', '.jpeg', '.png'}
CERT_TYPES = ('车辆行驶证', '车辆登记证')


def doc_to_pdf(path, out):
    import win32com.client as win32
    app = win32.DispatchEx('Word.Application')
    app.Visible = False
    app.DisplayAlerts = 0
    try:
        doc = app.Documents.Open(os.path.abspath(path))
        doc.ExportAsFixedFormat(os.path.abspath(out), 17)
        doc.Close(False)
    finally:
        try:
            app.Quit()
        except Exception:
            pass
    return out


def do_stage(root, company, out_dir=''):
    """把已归档的权证整理成可上传副本，并输出清单（供宿主侧浏览器通道上传）。"""
    comps = [c for c in list_companies(root) if c['name'] == company]
    if not comps:
        raise RuntimeError('未找到公司目录：%s' % company)
    target = comps[0]['target']
    idx = load_index(target)
    if not idx:
        raise RuntimeError('还没有归档记录，先跑一次识别归档')
    out = out_dir or os.path.join(target, '_upload')
    if os.path.isdir(out):
        shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    items = []
    for key in sorted(idx.keys()):
        rec = idx.get(key) or {}
        plate = rec.get('plate') or key.split('|')[0]
        typ = rec.get('type') or (key.split('|')[1] if '|' in key else '')
        if typ not in CERT_TYPES:
            continue
        src = rec.get('target') or os.path.join(target, rec.get('targetName') or '')
        if not os.path.isfile(src):
            continue
        ext = os.path.splitext(src)[1].lower()
        base = safe(plate + typ)
        if ext in UPLOAD_EXT:
            dst = os.path.join(out, base + ext)
            shutil.copyfile(src, dst)
        else:
            dst = os.path.join(out, base + '.pdf')
            emit(event='log', msg='转 PDF：' + os.path.basename(src))
            try:
                doc_to_pdf(src, dst)
            except Exception as e:
                emit(event='log', msg='转 PDF 失败：' + os.path.basename(src) + '（' + str(e)[:80] + '）')
                continue
        items.append({'plate': plate, 'type': typ, 'name': os.path.basename(dst), 'source': src})
    emit(event='stage', dir=out, target=target, count=len(items), items=items)
    return items


COLS = ['序号', '号牌号码', '车辆类型', '所有人', '使用性质', '品牌型号', '车辆识别代号',
        '注册日期', '发证日期', '里程', '权证类型', '归档文件', '来源文件', '备注']
NEED = ['车辆类型', '使用性质', '品牌型号', '车辆识别代号', '注册日期']


def do_report(root, company):
    comps = [c for c in list_companies(root) if c['name'] == company]
    if not comps:
        raise RuntimeError('没找到公司目录：%s' % company)
    target = comps[0]['target']
    idx = load_index(target)
    if not idx:
        raise RuntimeError('还没有归档记录，先跑识别归档')
    try:
        if fix_plates(comps[0]['dir'], target, idx):
            normalize_records(idx)
            save_index(target, idx)
    except Exception as e:
        emit(event='log', msg='车牌规范化跳过：%s' % e)
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    by_plate = {}
    for rec in idx.values():
        p = rec.get('plate') or '未知车牌'
        row = by_plate.setdefault(p, {'plate': p, 'types': {}, 'files': []})
        row['types'][rec.get('type')] = rec
        if rec.get('targetName'):
            row['files'].append(rec['targetName'])

    order = ['车辆行驶证', '车辆登记证', '里程']
    rows = []
    for p in sorted(by_plate):
        agg = by_plate[p]
        fields = {}
        for typ in order:
            rec = agg['types'].get(typ)
            if not rec:
                continue
            for k, v in (rec.get('fields') or {}).items():
                if v and not fields.get(k):
                    fields[k] = v
        rows.append({'plate': p, 'fields': fields, 'types': [t for t in order if t in agg['types']],
                     'files': agg['files'], 'sources': [os.path.basename(r.get('source') or '')
                                                        for r in agg['types'].values()]})

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '车辆权证信息'
    thin = Side(style='thin', color='BFBFBF')
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_fill = PatternFill('solid', fgColor='1F4E79')
    for i, col in enumerate(COLS, start=1):
        cell = ws.cell(row=1, column=i, value=col)
        cell.font = Font(bold=True, color='FFFFFF', size=11)
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal='center', vertical='center')
        cell.border = border
    for n, r in enumerate(rows, start=1):
        f = r['fields']
        miss = [k for k in NEED if not f.get(k)]
        if not f.get('里程'):
            miss.append('里程')
        note = ('缺' + '、'.join(miss)) if miss else ''
        vals = [n, r['plate'], f.get('车辆类型', ''), f.get('所有人', ''), f.get('使用性质', ''),
                f.get('品牌型号', ''), f.get('车辆识别代号', ''), f.get('注册日期', ''),
                f.get('发证日期', ''), f.get('里程', ''), '、'.join(r['types']),
                '、'.join(r['files']), '、'.join([s for s in r['sources'] if s]), note]
        for i, v in enumerate(vals, start=1):
            cell = ws.cell(row=n + 1, column=i, value=v)
            cell.border = border
            cell.alignment = Alignment(vertical='center', wrap_text=(i in (4, 6, 12, 13)))
    widths = [6, 12, 24, 32, 11, 27, 22, 13, 13, 10, 17, 30, 34, 30]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = 'A1:%s%d' % (get_column_letter(len(COLS)), len(rows) + 1)
    from openpyxl.worksheet.properties import PageSetupProperties
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    ws.page_setup.orientation = 'landscape'
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = '1:1'
    ws.page_margins.left = ws.page_margins.right = 0.3
    ws.page_margins.top = ws.page_margins.bottom = 0.4

    ws2 = wb.create_sheet('资料明细')
    cols2 = ['车牌', '类型', '归档文件', '来源文件', '识别字数', '识别时间']
    for i, col in enumerate(cols2, start=1):
        cell = ws2.cell(row=1, column=i, value=col)
        cell.font = Font(bold=True, color='FFFFFF')
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal='center')
    for n, rec in enumerate(sorted(idx.values(), key=lambda x: ((x.get('plate') or ''), (x.get('type') or ''))), start=1):
        vals = [rec.get('plate', ''), rec.get('type', ''), rec.get('targetName', ''),
                os.path.basename(rec.get('source') or ''), rec.get('mdLen', ''), rec.get('at', '')]
        for i, v in enumerate(vals, start=1):
            ws2.cell(row=n + 1, column=i, value=v)
    for i, w in enumerate([12, 14, 34, 46, 10, 20], start=1):
        ws2.column_dimensions[get_column_letter(i)].width = w
    ws2.freeze_panes = 'A2'
    from openpyxl.worksheet.properties import PageSetupProperties as _PSP
    ws2.sheet_properties.pageSetUpPr = _PSP(fitToPage=True)
    ws2.page_setup.orientation = 'landscape'
    ws2.page_setup.fitToWidth = 1
    ws2.page_setup.fitToHeight = 0
    ws2.print_title_rows = '1:1'

    out = os.path.join(target, '车辆权证信息表.xlsx')
    wb.save(out)
    emit(event='report', path=out, rows=len(rows), details=len(idx))
    return out


def do_ocr_opts(opts):
    """识别引擎的设置与自检：
    ocr [--engine auto|baidu|mineru|mineru-pro] [--ak K] [--sk S]
        [--mineru-token T] [--mineru-model vlm|pipeline]
        [--baidu-limit N] [--mineru-limit N] [--check] [--test 图片] [--reset-usage]
    """
    lim = {}
    if str(opts.get('baidu-limit') or '').strip().isdigit():
        lim['baidu_month'] = int(opts['baidu-limit'])
    if str(opts.get('mineru-limit') or '').strip().isdigit():
        lim['mineru_day'] = int(opts['mineru-limit'])
    if (opts.get('engine') or opts.get('ak') or opts.get('sk') or opts.get('mineru-token')
            or opts.get('mineru-model') or lim):
        save_ocr_cfg(opts.get('engine') or None, opts.get('ak') or None, opts.get('sk') or None,
                     opts.get('mineru-token') or None, opts.get('mineru-model') or None, lim or None)
    if opts.get('reset-usage'):
        save_usage({'limits': load_usage()['limits']})
    cfg = load_ocr_cfg()
    out = {'event': 'ocr', 'engine': cfg.get('engine') or 'auto', 'resolved': resolve_engine(cfg.get('engine')),
           'akMasked': mask_key(cfg['baidu']['ak']), 'hasKey': bool(cfg['baidu']['ak'] and cfg['baidu']['sk']),
           'mineru': bool(MINERU),
           'mineruTokenMasked': mask_key(cfg['mineru']['token']),
           'hasMineruToken': bool(cfg['mineru']['token']),
           'mineruModel': cfg['mineru']['model'],
           'limits': cfg['limits'],
           'usage': usage_summary(), 'usageLine': usage_line(),
           'engines': ['auto', 'baidu', 'mineru', 'mineru-pro']}
    if opts.get('check'):
        msgs = []
        ok = True
        try:
            baidu_token(cfg['baidu']['ak'], cfg['baidu']['sk'], force=True)
            msgs.append('百度 access_token 获取成功')
        except Exception as e:
            ok = False
            msgs.append('百度失败：%s: %s' % (type(e).__name__, e))
        if cfg['mineru']['token']:
            code, so, se = run([MINERU, 'status'], timeout=60) if MINERU else (1, '', '没找到 mineru')
            msgs.append('MinerU token 已配置（status rc=%s）' % code)
            if not MINERU:
                ok = False
        else:
            msgs.append('MinerU 精准解析 token 未配置（只能走轻量）')
        out['ok'] = ok
        out['msg'] = '；'.join(msgs)
    p = opts.get('test') or ''
    if p:
        if p.startswith('b64:'):
            p = base64.b64decode(p[4:]).decode('utf-8')
        eng = opts.get('test-engine') or resolve_engine(cfg.get('engine'))
        d = {}
        try:
            md = ocr_image_md(p, None, eng, d)
            out['ok'] = True
            out['engineUsed'] = eng
            out['test'] = os.path.basename(p)
            out['fields'] = d
            out['mdLen'] = len(md)
            out['mdHead'] = md[:600]
            out['usage'] = usage_summary()
            out['usageLine'] = usage_line()
        except Exception as e:
            out['ok'] = False
            out['error'] = '%s: %s' % (type(e).__name__, e)
    emit(**out)


def do_usage_opts(opts):
    """用量：usage [--reset]  —— 只读返回各引擎本周期已用次数/额度。"""
    if opts.get('reset'):
        save_usage({'limits': load_usage()['limits']})
    out = {'event': 'usage', 'line': usage_line()}
    out.update(usage_summary())
    emit(**out)


def main():
    args = sys.argv[1:]
    if not args:
        emit(event='error', msg='缺少子命令：companies / scan / run / report')
        return 2
    cmd = args[0]
    opts = {}
    i = 1
    while i < len(args):
        a = args[i]
        if a.startswith('--'):
            k = a[2:]
            if k in ('no-ocr', 'reset', 'check', 'reset-usage'):
                opts[k] = True
                i += 1
                continue
            opts[k] = args[i + 1] if i + 1 < len(args) else ''
            i += 2
        else:
            i += 1
    root = opts.get('root') or ''
    company = opts.get('company') or ''
    source = opts.get('source') or None
    try:
        if cmd == 'companies':
            do_companies(root)
        elif cmd == 'scan':
            do_scan(root, company or None, source, int(opts.get('limit') or 0))
        elif cmd == 'run':
            if not company:
                raise RuntimeError('run 需要 --company')
            do_run(root, company, source, int(opts.get('limit') or 0), not opts.get('no-ocr'),
                   opts.get('engine') or None)
        elif cmd == 'fix':
            if not company:
                raise RuntimeError('fix 需要 --company')
            do_fix(root, company)
        elif cmd == 'ocr':
            do_ocr_opts(opts)
        elif cmd == 'usage':
            do_usage_opts(opts)
        elif cmd == 'stage':
            if not company:
                raise RuntimeError('stage 需要 --company')
            do_stage(root, company, opts.get('out') or '')
        elif cmd == 'report':
            if not company:
                raise RuntimeError('report 需要 --company')
            do_report(root, company)
        else:
            raise RuntimeError('未知子命令：%s' % cmd)
    except Exception as e:
        emit(event='error', msg='%s: %s' % (type(e).__name__, e))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())