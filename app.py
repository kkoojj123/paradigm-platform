#!/usr/bin/env python3
"""运营活动平台 v2 - Flask后端"""

import os
import sys
import re
import csv
import json
import hashlib
import subprocess
import io
from datetime import datetime
from functools import wraps

from flask import Flask, request, session, jsonify, render_template, send_file, make_response

# 添加core.py路径
sys.path.insert(0, '/home/node/.openclaw/workspace/potential-creator-radar')

app = Flask(__name__)
app.secret_key = 'xhs_game_theater_2026_secret'
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.config['PERMANENT_SESSION_LIFETIME'] = 86400 * 7  # 7天

# 文件上传目录
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'static', 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# SQLite
import sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), 'platform_v2.db')


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def hash_password(pw):
    return hashlib.sha256(pw.encode()).hexdigest()


def init_db():
    conn = get_db()
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password TEXT,
            display_name TEXT DEFAULT '',
            xhs_uid TEXT DEFAULT '',
            xhs_avatar TEXT DEFAULT '',
            company TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS topics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT DEFAULT 'topic',
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            benefits TEXT DEFAULT '',
            reward_amount INTEGER DEFAULT 0,
            reward_rules TEXT DEFAULT '',
            ref_notes TEXT DEFAULT '[]',
            requirements TEXT DEFAULT '',
            directions TEXT DEFAULT '[]',
            source TEXT DEFAULT 'operator',
            status TEXT DEFAULT 'published',
            created_by INTEGER,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            topic_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            note_id TEXT NOT NULL,
            note_title TEXT DEFAULT '',
            cover_url TEXT DEFAULT '',
            likes INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            reviewed_at TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS hot_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT UNIQUE NOT NULL,
            title TEXT DEFAULT '',
            cover TEXT DEFAULT '',
            likes INTEGER DEFAULT 0,
            author TEXT DEFAULT '',
            game_ip TEXT DEFAULT '',
            fetched_at TEXT DEFAULT (datetime('now','localtime'))
        );
    """)
    conn.commit()

    # 兼容已有DB：动态加字段
    for col, default in [('requirements', "''"), ('directions', "'[]'"), ('cover_url', "''"), ('deadline', "''")]:
        try:
            conn.execute(f"ALTER TABLE topics ADD COLUMN {col} TEXT DEFAULT {default}")
            conn.commit()
        except Exception:
            pass

    # 预置operator账号
    existing = c.execute("SELECT id FROM users WHERE username='operator'").fetchone()
    if not existing:
        c.execute("""
            INSERT INTO users (role, username, password, display_name)
            VALUES ('operator', 'operator', ?, '运营君')
        """, (hash_password('xhs2026'),))
        conn.commit()

    # 预置3条示例选题
    count = c.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
    if count == 0:
        demo_topics = [
            ('topic', '【原神】旅行者搞笑日常二创征集', '征集旅行者在提瓦特大陆的搞笑日常片段，欢迎各种剧情改编和趣味创作！', '优质作品将获得官方推荐流量扶持', 0, '', '[]', 'operator', 'published', 1),
            ('plan', '《黑神话悟空》通关纪念企划', '纪念玩家通关《黑神话悟空》，征集最感动的通关瞬间和游戏感想视频', '前50名参与者均可获得专属称号，万赞视频额外奖励', 5000, '投稿视频点赞超过1000即可参与奖励池分配', '[]', 'operator', 'published', 1),
            ('topic', '2024年度最佳游戏BGM二创', '用你喜欢的游戏音乐制作二创视频，可以是翻唱、改编、剪辑等任意形式', '精选作品将获得平台首页展示机会', 0, '', '[]', 'operator', 'published', 1),
        ]
        c.executemany("""
            INSERT INTO topics (type, title, description, benefits, reward_amount, reward_rules, ref_notes, source, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, demo_topics)
        conn.commit()

    # 预置3条热点笔记
    hn_count = c.execute("SELECT COUNT(*) FROM hot_notes").fetchone()[0]
    if hn_count == 0:
        demo_hot = [
            ('683b2d8c000000001303b20e', '黑神话悟空最难关卡竟然是这个？全程高能！', 'https://picsum.photos/seed/hw1/400/400', 28600, '游戏达人小白', '黑神话悟空'),
            ('683a1f2b000000001201c33f', '原神4.9版本最强角色测评，这套阵容无脑好用', 'https://picsum.photos/seed/ys2/400/400', 15400, '提瓦特攻略组', '原神'),
            ('6839e4a1000000001102d55a', '王者荣耀职业联赛高燃混剪，每一帧都是名场面', 'https://picsum.photos/seed/kpl3/400/400', 32100, '电竞剪辑师', '王者荣耀'),
        ]
        c.executemany("""
            INSERT INTO hot_notes (note_id, title, cover, likes, author, game_ip)
            VALUES (?, ?, ?, ?, ?, ?)
        """, demo_hot)
        conn.commit()

    conn.close()


# ========== 装饰器 ==========

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': '请先登录'}), 401
        return f(*args, **kwargs)
    return decorated


def operator_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session or session.get('role') != 'operator':
            return jsonify({'error': '需要运营权限'}), 403
        return f(*args, **kwargs)
    return decorated


# ========== 路由：页面 ==========

@app.route('/')
def index():
    from flask import make_response
    resp = make_response(render_template('index.html'))
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    return resp


@app.route('/admin')
def admin():
    from flask import make_response
    resp = make_response(render_template('admin.html'))
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    return resp


# ========== 路由：认证 ==========

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400

    conn = get_db()
    # 先尝试用 username 登录，再尝试 display_name（创作者用小红书昵称登录）
    user = conn.execute(
        "SELECT * FROM users WHERE username=? AND password=?",
        (username, hash_password(password))
    ).fetchone()
    if not user:
        user = conn.execute(
            "SELECT * FROM users WHERE display_name=? AND password=?",
            (username, hash_password(password))
        ).fetchone()
    conn.close()

    if not user:
        return jsonify({'error': '昵称或密码错误'}), 401

    # 检查审核状态（运营账号跳过）
    vs = user['verify_status'] if 'verify_status' in user.keys() else 'approved'
    if vs == 'pending':
        return jsonify({'error': '你的账号正在审核中，请等待运营验证，通过后即可登录'}), 403
    if vs == 'rejected':
        return jsonify({'error': '你的注册申请未通过审核，如有留1请联系运营'}), 403

    session.permanent = True
    session['user_id'] = user['id']
    session['role'] = user['role']
    session['username'] = user['username']
    session['display_name'] = user['display_name'] or user['username']

    return jsonify({
        'id': user['id'],
        'role': user['role'],
        'username': user['username'],
        'display_name': user['display_name'] or user['username'],
        'xhs_avatar': user['xhs_avatar'],
    })


@app.route('/api/auth/register', methods=['POST'])
def register():
    """创作者注册：小红书昵称 + 主页链接 + 主页截图路径 + 密码"""
    data = request.get_json() or {}
    display_name = data.get('display_name', '').strip()   # 小红书昵称
    xhs_profile_url = data.get('xhs_profile_url', '').strip()  # 主页链接
    xhs_screenshot = data.get('xhs_screenshot', '').strip()    # 截图路径（上传后拿到的URL）
    password = data.get('password', '')

    if not display_name:
        return jsonify({'error': '请填写小红书昵称'}), 400
    if not xhs_profile_url:
        return jsonify({'error': '请填写小红书主页链接'}), 400
    if not xhs_screenshot:
        return jsonify({'error': '请上传小红书主页截图'}), 400
    if not password:
        return jsonify({'error': '请设置登录密码'}), 400
    if len(password) < 6:
        return jsonify({'error': '密码至少6位'}), 400
    if not xhs_profile_url.startswith('http'):
        return jsonify({'error': '主页链接格式不正确'}), 400

    # 以小红书昵称作为 username（唯一）
    import time
    username = f'creator_{int(time.time()*1000)}'  # 内部唯一ID，不展示
    conn = get_db()
    try:
        conn.execute("""
            INSERT INTO users (role, username, password, display_name, xhs_profile_url, xhs_screenshot, verify_status)
            VALUES ('creator', ?, ?, ?, ?, ?, 'pending')
        """, (username, hash_password(password), display_name, xhs_profile_url, xhs_screenshot))
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        session.permanent = True
        session['user_id'] = user['id']
        session['role'] = user['role']
        session['username'] = user['username']
        session['display_name'] = user['display_name']
        conn.close()
        return jsonify({
            'id': user['id'],
            'role': user['role'],
            'username': user['username'],
            'display_name': user['display_name'],
            'verify_status': 'pending',
            'message': '注册成功！运营将在 1-2 个工作日内审核你的账号，审核通过后即可登录'
        }), 201
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': '该昵称已被注册'}), 409


@app.route('/api/upload', methods=['POST'])
def upload_file():
    """通用文件上传（截图/封面图）"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    f = request.files['file']
    if f.filename == '' or not allowed_file(f.filename):
        return jsonify({'error': '不支持的文件类型'}), 400
    import time
    from werkzeug.utils import secure_filename
    ext = f.filename.rsplit('.', 1)[1].lower()
    fname = f'{int(time.time()*1000)}.{ext}'
    save_path = os.path.join(UPLOAD_FOLDER, fname)
    f.save(save_path)
    url = f'/static/uploads/{fname}'
    return jsonify({'url': url, 'filename': fname})


@app.route('/api/auth/xhs_login', methods=['POST'])
def xhs_login():
    """创作者登录，解析UID，验证存在"""
    data = request.get_json() or {}
    link = data.get('link', '').strip()
    if not link:
        return jsonify({'error': '请输入小红书主页链接'}), 400

    # 解析UID
    m = re.search(r'/user/profile/([a-f0-9]+)', link)
    uid = m.group(1) if m else link.strip()

    display_name = uid
    avatar = ''

    # 调fetch-user-info.sh验证UID
    try:
        r = subprocess.run(
            ['bash', '/home/node/.openclaw/workspace/skills/skills/note-query/scripts/fetch-user-info.sh', uid],
            capture_output=True, text=True, timeout=15
        )
        if r.returncode == 0 and r.stdout.strip():
            try:
                info = json.loads(r.stdout.strip())
                display_name = info.get('nickname', uid) or uid
                avatar = info.get('image', '') or ''
            except Exception:
                pass
    except Exception:
        pass  # 验证失败不阻断登录

    conn = get_db()
    # 查找或创建创作者账号
    user = conn.execute("SELECT * FROM users WHERE xhs_uid=?", (uid,)).fetchone()
    if not user:
        # 创建账号
        username = f'creator_{uid[:16]}'
        # 避免用户名冲突
        base = username
        i = 1
        while conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
            username = f'{base}_{i}'
            i += 1
        conn.execute("""
            INSERT INTO users (role, username, display_name, xhs_uid, xhs_avatar)
            VALUES ('creator', ?, ?, ?, ?)
        """, (username, display_name, uid, avatar))
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE xhs_uid=?", (uid,)).fetchone()
    else:
        # 更新display_name和avatar
        conn.execute("UPDATE users SET display_name=?, xhs_avatar=? WHERE xhs_uid=?",
                     (display_name, avatar, uid))
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE xhs_uid=?", (uid,)).fetchone()

    session.permanent = True
    session['user_id'] = user['id']
    session['role'] = user['role']
    session['username'] = user['username']
    session['display_name'] = display_name

    conn.close()
    return jsonify({
        'id': user['id'],
        'role': user['role'],
        'username': user['username'],
        'display_name': display_name,
        'xhs_avatar': avatar,
        'xhs_uid': uid,
    })


@app.route('/api/auth/me')
def me():
    if 'user_id' not in session:
        return jsonify({'logged_in': False})
    return jsonify({
        'logged_in': True,
        'id': session['user_id'],
        'role': session['role'],
        'username': session['username'],
        'display_name': session.get('display_name', session['username']),
    })


@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})


# ========== 路由：选题 ==========

def serialize_topic(row):
    d = dict(row)
    for field in ('ref_notes', 'directions'):
        v = d.get(field)
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                # 处理双重 JSON 编码（数据存入时被 encode 了两次）
                if isinstance(parsed, str):
                    parsed = json.loads(parsed)
                d[field] = parsed
            except: d[field] = []
        elif v is None:
            d[field] = []
    # 确保 directions 里的每个方向都有 notes 字段（兼容前端 dir.notes）
    if isinstance(d.get('directions'), list):
        for dir_obj in d['directions']:
            if isinstance(dir_obj, dict) and 'notes' not in dir_obj:
                dir_obj['notes'] = dir_obj.get('ref_notes', [])
    return d

@app.route('/api/topics', methods=['GET'])
def get_topics():
    type_ = request.args.get('type', '')
    source = request.args.get('source', '')

    conn = get_db()
    show_all = request.args.get('all', '') == '1' and session.get('role') == 'operator'
    # 创作者端：published + offline 都显示（offline 显示水印），只隐藏 pending
    status_filter = "1=1" if show_all else "t.status IN ('published', 'offline')"
    sql = f"SELECT t.*, u.display_name as creator_name, (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as submission_count FROM topics t LEFT JOIN users u ON t.created_by=u.id WHERE {status_filter}"
    params = []
    if type_:
        sql += " AND t.type=?"
        params.append(type_)
    if source:
        sql += " AND t.source=?"
        params.append(source)
    sql += " ORDER BY t.created_at DESC"

    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return jsonify([serialize_topic(r) for r in rows])


@app.route('/api/topics/<int:topic_id>', methods=['GET'])
def get_topic(topic_id):
    conn = get_db()
    row = conn.execute(
        "SELECT t.*, u.display_name as creator_name, (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as sub_count FROM topics t LEFT JOIN users u ON t.created_by=u.id WHERE t.id=?",
        (topic_id,)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': '不存在'}), 404
    return jsonify(serialize_topic(row))


@app.route('/api/topics', methods=['POST'])
@login_required
def create_topic():
    data = request.get_json() or {}
    title = data.get('title', '').strip()
    if not title:
        return jsonify({'error': '标题不能为空'}), 400

    role = session.get('role')
    # 运营直接发布，其他待审核
    status = 'published' if role == 'operator' else 'pending'
    source_map = {'operator': 'operator', 'brand': 'brand', 'creator': 'creator'}
    source = source_map.get(role, 'creator')

    conn = get_db()
    c = conn.execute("""
        INSERT INTO topics (type, title, description, benefits, reward_amount, reward_rules, ref_notes, requirements, directions, source, status, created_by, cover_url, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        data.get('type', 'topic'),
        title,
        data.get('description', ''),
        data.get('benefits', ''),
        int(data.get('reward_amount', 0)),
        data.get('reward_rules', ''),
        json.dumps(data.get('ref_notes', []), ensure_ascii=False),
        data.get('requirements', ''),
        json.dumps(data.get('directions', []), ensure_ascii=False),
        source,
        status,
        session['user_id'],
        data.get('cover_url', ''),
        data.get('deadline', ''),
    ))
    conn.commit()
    topic_id = c.lastrowid
    row = conn.execute("SELECT * FROM topics WHERE id=?", (topic_id,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@app.route('/api/topics/<int:topic_id>/status', methods=['PUT'])
@operator_required
def update_topic_status(topic_id):
    data = request.get_json() or {}
    status = data.get('status')
    if status not in ('published', 'pending', 'offline'):
        return jsonify({'error': '无效状态'}), 400
    conn = get_db()
    conn.execute("UPDATE topics SET status=? WHERE id=?", (status, topic_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/topics/<int:topic_id>', methods=['PUT'])
@login_required
def update_topic(topic_id):
    if session.get('role') != 'operator':
        return jsonify({'error': '无权限'}), 403
    data = request.get_json() or {}
    conn = get_db()
    row = conn.execute('SELECT id FROM topics WHERE id=?', (topic_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': '选题不存在'}), 404
    fields = []
    vals = []
    for key in ['title', 'description', 'requirements', 'source', 'type', 'cover_url', 'deadline', 'participant_count']:
        if key in data:
            fields.append(f'{key}=?')
            vals.append(data[key])
    if 'ref_notes' in data:
        fields.append('ref_notes=?')
        vals.append(json.dumps(data['ref_notes'], ensure_ascii=False))
    if 'directions' in data:
        fields.append('directions=?')
        vals.append(json.dumps(data['directions'], ensure_ascii=False))
    if fields:
        vals.append(topic_id)
        conn.execute(f"UPDATE topics SET {','.join(fields)} WHERE id=?", vals)
        conn.commit()
    conn.close()
    return jsonify({'ok': True})


# 运营获取所有选题（含待审核）
@app.route('/api/admin/topics', methods=['GET'])
@operator_required
def admin_get_topics():
    conn = get_db()
    rows = conn.execute("""
        SELECT t.*, u.display_name as creator_name,
               (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as sub_count,
               (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='pending') as sub_pending,
               (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='approved') as sub_approved,
               (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='rejected') as sub_rejected,
               (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.submit_type='draft') as sub_draft,
               (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.submit_type='existing') as sub_existing
        FROM topics t LEFT JOIN users u ON t.created_by=u.id
        ORDER BY t.created_at DESC
    """).fetchall()
    conn.close()
    return jsonify([serialize_topic(r) for r in rows])


@app.route('/api/admin/users', methods=['GET'])
@operator_required
def admin_get_users():
    role = request.args.get('role', '')
    verify_status = request.args.get('verify_status', '')
    conn = get_db()
    sql = """
        SELECT u.id, u.username, u.display_name, u.role, u.company, u.created_at,
               u.xhs_profile_url, u.xhs_screenshot, u.verify_status, u.verify_note, u.verified_at,
               (SELECT COUNT(*) FROM submissions s WHERE s.user_id=u.id) as sub_count,
               (SELECT MAX(s.created_at) FROM submissions s WHERE s.user_id=u.id) as last_sub_at
        FROM users u WHERE u.role != 'operator'
    """
    params = []
    if role:
        sql += " AND u.role=?"
        params.append(role)
    if verify_status:
        sql += " AND u.verify_status=?"
        params.append(verify_status)
    sql += " ORDER BY u.created_at DESC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d.pop('password', None)
        result.append(d)
    return jsonify(result)


@app.route('/api/admin/users/<int:user_id>/verify', methods=['PUT'])
@operator_required
def admin_verify_user(user_id):
    """审核创作者注册申请"""
    data = request.get_json() or {}
    status = data.get('status')  # 'approved' | 'rejected'
    note = data.get('note', '')  # 审核备注
    if status not in ('approved', 'rejected'):
        return jsonify({'error': '无效状态'}), 400
    conn = get_db()
    conn.execute(
        "UPDATE users SET verify_status=?, verify_note=?, verified_at=datetime('now','localtime') WHERE id=? AND role='creator'",
        (status, note, user_id)
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/topics/<int:topic_id>', methods=['DELETE'])
def delete_topic(topic_id):
    if session.get('role') != 'operator':
        return jsonify({'error': '无权限'}), 403
    conn = get_db()
    conn.execute("DELETE FROM topics WHERE id=?", (topic_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

@app.route('/api/admin/topics/<int:topic_id>', methods=['DELETE'])
@operator_required
def admin_delete_topic(topic_id):
    conn = get_db()
    conn.execute("DELETE FROM topics WHERE id=?", (topic_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


# ========== 路由：投稿 ==========

@app.route('/api/submissions', methods=['GET'])
@login_required
def get_submissions():
    conn = get_db()
    topic_id = request.args.get('topic_id', type=int)
    if session.get('role') == 'operator':
        if topic_id:
            rows = conn.execute("""
                SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
                FROM submissions s
                LEFT JOIN users u ON s.user_id=u.id
                LEFT JOIN topics t ON s.topic_id=t.id
                WHERE s.topic_id=?
                ORDER BY s.created_at DESC
            """, (topic_id,)).fetchall()
        else:
            rows = conn.execute("""
                SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
                FROM submissions s
                LEFT JOIN users u ON s.user_id=u.id
                LEFT JOIN topics t ON s.topic_id=t.id
                ORDER BY s.created_at DESC
            """).fetchall()
    else:
        if topic_id:
            rows = conn.execute("""
                SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
                FROM submissions s
                LEFT JOIN users u ON s.user_id=u.id
                LEFT JOIN topics t ON s.topic_id=t.id
                WHERE s.user_id=? AND s.topic_id=?
                ORDER BY s.created_at DESC
            """, (session['user_id'], topic_id)).fetchall()
        else:
            rows = conn.execute("""
                SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
                FROM submissions s
                LEFT JOIN users u ON s.user_id=u.id
                LEFT JOIN topics t ON s.topic_id=t.id
                WHERE s.user_id=?
                ORDER BY s.created_at DESC
            """, (session['user_id'],)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/topics/<int:topic_id>/approved-submissions', methods=['GET'])
def get_approved_submissions(topic_id):
    conn = get_db()
    rows = conn.execute('''
        SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name
        FROM submissions s
        LEFT JOIN users u ON s.user_id=u.id
        WHERE s.topic_id=? AND s.status='approved'
        ORDER BY s.created_at DESC
    ''', (topic_id,)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/submissions', methods=['POST'])
@login_required
def create_submission():
    data = request.get_json() or {}
    topic_id = data.get('topic_id')
    submit_type = data.get('submit_type', 'existing')  # existing 或 draft
    if not topic_id:
        return jsonify({'error': '缺少topic_id'}), 400

    if submit_type == 'existing':
        # 已有作品：需要笔记链接+个人信息
        note_link = data.get('note_link', '').strip()
        real_name = data.get('real_name', '').strip()
        profile_link = data.get('profile_link', '').strip()
        if not note_link:
            return jsonify({'error': '请填写笔记链接'}), 400
        # 从链接提取 note_id
        import re as _re
        m = _re.search(r'/explore/([a-f0-9]+)', note_link)
        note_id = m.group(1) if m else note_link
    else:
        # 脚本思路：需要主页链接+联系方式
        profile_link = data.get('profile_link', '').strip()
        contact = data.get('contact', '').strip()
        draft_content = data.get('draft_content', '').strip()
        if not profile_link or not draft_content:
            return jsonify({'error': '请填写主页链接和脚本思路'}), 400
        note_id = ''
        real_name = data.get('real_name', '')
        note_link = ''

    conn = get_db()
    # 检查是否重复投稿：运营添加按 note_id 判重，创作者允许多次投稿
    if session.get('role') == 'operator' and submit_type == 'existing':
        dup = conn.execute(
            "SELECT id FROM submissions WHERE topic_id=? AND note_id=?",
            (topic_id, note_id)
        ).fetchone()
        if dup:
            conn.close()
            return jsonify({'error': '该笔记已添加过'}), 409

    # 查询该用户在该选题的已投稿次数，作为本次序号
    count_row = conn.execute(
        "SELECT COUNT(*) FROM submissions WHERE topic_id=? AND user_id=?",
        (topic_id, session['user_id'])
    ).fetchone()
    submission_number = (count_row[0] if count_row else 0) + 1

    c = conn.execute("""
        INSERT INTO submissions
        (topic_id, user_id, note_id, note_title, cover_url, likes,
         submit_type, note_link, profile_link, contact, real_name, draft_content,
         review_status, status, created_at, submission_number)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),?)
    """, (
        topic_id, session['user_id'],
        note_id,
        data.get('note_title', ''),
        data.get('cover_url', ''),
        int(data.get('likes', 0)),
        submit_type,
        note_link if submit_type == 'existing' else '',
        data.get('profile_link', ''),
        data.get('contact', ''),
        data.get('real_name', ''),
        data.get('draft_content', '') if submit_type == 'draft' else '',
        'approved' if data.get('status') == 'approved' else 'pending',  # review_status
        data.get('status', 'pending'),  # status
        submission_number,  # submission_number
    ))
    conn.commit()
    sub_id = c.lastrowid
    row = conn.execute("SELECT * FROM submissions WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@app.route('/api/submissions/<int:sub_id>', methods=['PUT'])
@login_required
def update_submission(sub_id):
    """修改投稿（创作者改自己的，运营可改任意）"""
    data = request.get_json() or {}
    is_operator = session.get('role') == 'operator'
    
    conn = get_db()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sub_id,)).fetchone()
    if not sub:
        conn.close()
        return jsonify({'error': '投稿不存在'}), 404
    if sub['user_id'] != session['user_id'] and not is_operator:
        conn.close()
        return jsonify({'error': '无权限'}), 403
    
    # 运营可以单独修改状态和备注
    status = data.get('status', sub['status'])
    review_note = data.get('review_note', sub['review_note'])
    
    if sub['submit_type'] == 'existing':
        note_link = data.get('note_link', '').strip()
        if note_link:
            import re as _re
            m = _re.search(r'/explore/([a-f0-9]+)', note_link)
            note_id = m.group(1) if m else note_link
        else:
            note_id = sub['note_id']
            note_link = sub['note_link']
        conn.execute(
            "UPDATE submissions SET note_id=?, note_link=?, profile_link=?, "
            "note_title=?, cover_url=?, likes=?, status=?, review_note=?, "
            "creator_name=?, reviewed_at=datetime('now','localtime') "
            "WHERE id=?",
            (
                note_id, note_link,
                data.get('profile_link', sub['profile_link']),
                data.get('note_title', sub['note_title']),
                data.get('cover_url', sub['cover_url']),
                int(data.get('likes', sub['likes'])),
                status, review_note,
                data.get('creator_name', sub['creator_name']),
                sub_id
            )
        )
    else:
        profile_link = data.get('profile_link', '').strip()
        draft_content = data.get('draft_content', '').strip()
        contact = data.get('contact', '').strip()
        if profile_link or draft_content:
            conn.execute(
                "UPDATE submissions SET profile_link=?, contact=?, draft_content=?, "
                "status=?, review_note=?, reviewed_at=datetime('now','localtime') "
                "WHERE id=?",
                (
                    profile_link or sub['profile_link'],
                    contact or sub['contact'],
                    draft_content or sub['draft_content'],
                    status, review_note, sub_id
                )
            )
    
    conn.commit()
    row = conn.execute("SELECT * FROM submissions WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(row))


@app.route('/api/submissions/<int:sub_id>/status', methods=['PUT'])
@operator_required
def update_submission_status(sub_id):
    data = request.get_json() or {}
    status = data.get('status')
    if status not in ('approved', 'rejected', 'pending'):
        return jsonify({'error': '无效状态'}), 400
    conn = get_db()
    review_note = data.get('review_note', '')
    conn.execute(
        "UPDATE submissions SET status=?, reviewed_at=datetime('now','localtime'), review_note=? WHERE id=?",
        (status, review_note, sub_id)
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/submissions/<int:sub_id>/suggestion', methods=['PUT'])
@operator_required
def add_submission_suggestion(sub_id):
    data = request.get_json()
    suggestion = data.get('suggestion', '')
    if not suggestion:
        return jsonify({'error': '建议内容不能为空'}), 400
    conn = get_db()
    # 追加到 review_note 字段
    row = conn.execute("SELECT review_note FROM submissions WHERE id=?", (sub_id,)).fetchone()
    existing = row[0] if row and row[0] else ''
    new_note = (existing + '\n\n--- 补充建议 ---\n' + suggestion) if existing else suggestion
    conn.execute("UPDATE submissions SET review_note=? WHERE id=?", (new_note, sub_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

@app.route('/api/submissions/<int:sub_id>', methods=['DELETE'])
@operator_required
def delete_submission(sub_id):
    """运营删除投稿"""
    conn = get_db()
    conn.execute("DELETE FROM submissions WHERE id=?", (sub_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})



@app.route('/api/submissions/export', methods=['GET'])
@operator_required
def export_submissions():
    conn = get_db()
    rows = conn.execute("""
        SELECT s.id, s.note_id, s.note_title, s.likes, s.status, s.created_at, s.reviewed_at,
               u.display_name as creator_name, u.xhs_uid,
               t.title as topic_title, t.type as topic_type
        FROM submissions s
        LEFT JOIN users u ON s.user_id=u.id
        LEFT JOIN topics t ON s.topic_id=t.id
        ORDER BY s.created_at DESC
    """).fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['ID', '笔记ID', '笔记标题', '点赞数', '状态', '创作者', 'XHS UID', '选题', '类型', '投稿时间', '审核时间'])
    for r in rows:
        writer.writerow([r['id'], r['note_id'], r['note_title'], r['likes'], r['status'],
                         r['creator_name'], r['xhs_uid'], r['topic_title'], r['topic_type'],
                         r['created_at'], r['reviewed_at']])

    output.seek(0)
    response = make_response(output.getvalue())
    response.headers['Content-Type'] = 'text/csv; charset=utf-8-sig'
    response.headers['Content-Disposition'] = f'attachment; filename=submissions_{datetime.now().strftime("%Y%m%d_%H%M%S")}.csv'
    return response


# ========== 路由：热点笔记 ==========

@app.route('/api/hot_notes/refresh', methods=['POST'])
def refresh_hot_notes():
    if session.get('role') != 'operator':
        return jsonify({'error': '无权限'}), 403
    # 后台异步触发热点抓取
    import threading
    def do_refresh():
        try:
            import subprocess, json as _json
            script = '/home/node/.openclaw/workspace/skills/skills/note-query/scripts/search-notes.sh'
            # 游戏热点灵感报告逻辑：横向扫10个IP
            GAMES = ['王者荣耀','第五人格','崩坏星穹铁道','三角洲行动',
                     '无畏契约','光遇','恋与深空','原神','蛋仔派对','和平精英']
            conn = get_db()
            conn.execute("DELETE FROM hot_notes")
            for game in GAMES:
                try:
                    r = subprocess.run(['bash', script,
                        '--keyword', game, '--note-type', 'VIDEO',
                        '--before-create-day', '7', '--min-likes', '3000',
                        '--sort-by', 'LIKES', '--page-size', '3'],
                        capture_output=True, text=True, timeout=25)
                    if not r.stdout.strip(): continue
                    d = _json.loads(r.stdout)
                    cards = d.get('data',{}).get('note_cards',[])
                    for c in cards[:3]:
                        b=c.get('note_base_info',{}); n=c.get('note_count_info',{})
                        u=c.get('user_info',{})
                        note_id=b.get('note_id',n.get('note_id',''))
                        if not note_id: continue
                        title=b.get('title','').strip()
                        if '非公开' in title or '已被设置' in title: continue
                        likes=n.get('like_count',0)
                        imgs=b.get('images',[])
                        cover=imgs[0].get('image_url','') if imgs else ''
                        conn.execute("INSERT OR REPLACE INTO hot_notes (note_id,title,cover,likes,author,game_ip,fetched_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))",
                            (note_id, title, cover, likes, u.get('nick_name',b.get('nickname','')), game))
                except Exception as e2:
                    print(f'[hot game={game}] {e2}')
            conn.commit(); conn.close()
            print('[hot refresh] 完成', flush=True)
        except Exception as e:
            print(f'[hot refresh] {e}')
    threading.Thread(target=do_refresh, daemon=True).start()
    return jsonify({'ok': True, 'message': '正在后台抓取'})

@app.route('/api/hot_notes', methods=['GET'])
def get_hot_notes():
    conn = get_db()
    rows = conn.execute("SELECT * FROM hot_notes ORDER BY likes DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ========== 路由：笔记信息 ==========

def ci_to_cdn(url):
    """把 ci.xiaohongshu.com / xhscdn.com 图片 URL 转换为 sns-img-hw.xhscdn.com 格式（服务端可代理）"""
    if not url:
        return url
    import re
    m = re.match(r'https?://(?:ci\.xiaohongshu\.com|xhscdn\.com|sns-img-hw\.xhscdn\.com)/([\w\-]+).*', url)
    if m:
        return f'https://sns-img-hw.xhscdn.com/{m.group(1)}?imageView2/2/w/300/format/jpg'
    return url


@app.route('/api/proxy_image')
def proxy_image():
    """代理图片，解决前端跨域问题"""
    import urllib.request
    url = request.args.get('url', '').strip()
    if not url or not url.startswith('http'):
        return '', 400
    # ci.xiaohongshu.com 转 xhscdn
    url = ci_to_cdn(url)
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.xiaohongshu.com/'
        })
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read()
            ct = resp.headers.get('Content-Type', 'image/jpeg')
        resp_obj = make_response(data)
        resp_obj.headers['Content-Type'] = ct
        resp_obj.headers['Cache-Control'] = 'public, max-age=86400'
        return resp_obj
    except Exception as e:
        return jsonify({'error': str(e)}), 502


@app.route('/api/fetch_note', methods=['GET'])
def fetch_note():
    note_id = request.args.get('note_id', '').strip()
    if not note_id:
        return jsonify({'error': '缺少note_id'}), 400

    try:
        from core import fetch_note_sidebar
        result = fetch_note_sidebar(note_id)
        if result:
            b = result.get('note_base_info', {})
            n = result.get('note_count_info', {})
            u = result.get('user_info', {})
            imgs = b.get('images', [])
            raw_cover = imgs[0].get('image_url', '') if imgs else ''
            return jsonify({
                'note_id': note_id,
                'title': b.get('title', ''),
                'cover': ci_to_cdn(raw_cover),
                'likes': n.get('like_count', 0),
                'collects': n.get('collect_count', 0),
                'author': u.get('nick_name', ''),
                'avatar': u.get('avatar_url', ''),
            })
        return jsonify({'error': '获取失败', 'note_id': note_id}), 404
    except Exception as e:
        return jsonify({
            'note_id': note_id,
            'title': '',
            'cover': '',
            'likes': 0,
            'error': str(e)
        }), 200


# ========== 路由：用户管理 ==========

@app.route('/api/users', methods=['GET'])
@operator_required
def get_users():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, role, username, display_name, xhs_uid, xhs_avatar, company, created_at FROM users WHERE role != 'operator' ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ========== 主程序 ==========

if __name__ == '__main__':
    init_db()
    print("🚀 运营活动平台 v2 启动中...")
    print(f"📍 访问地址: http://127.0.0.1:5056")
    print(f"🔧 管理后台: http://127.0.0.1:5056/admin")
    port = int(os.environ.get('PORT', 5056))
    app.run(host='0.0.0.0', port=port, debug=False)
