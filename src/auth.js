// ===== 认证相关 API =====
import { hashPassword, signJWT, verifyJWT, getSessionToken, setSessionCookie, clearSessionCookie, json, err, parseBody } from './utils.js';

const JWT_EXPIRE = 7 * 24 * 3600; // 7天

// 获取当前登录用户
export async function getCurrentUser(request, env) {
  const token = getSessionToken(request);
  if (!token) return null;
  const payload = await verifyJWT(token, env.SECRET_KEY);
  if (!payload) return null;
  return payload;
}

// POST /api/auth/login
export async function handleLogin(request, env) {
  const data = await parseBody(request);
  const username = (data.username || '').trim();
  const password = data.password || '';
  if (!username || !password) return err('用户名和密码不能为空');

  const pwHash = await hashPassword(password);
  let user = await env.DB.prepare(
    "SELECT * FROM users WHERE username=? AND password=?"
  ).bind(username, pwHash).first();

  if (!user) {
    user = await env.DB.prepare(
      "SELECT * FROM users WHERE display_name=? AND password=?"
    ).bind(username, pwHash).first();
  }

  if (!user) return err('昵称或密码错误', 401);

  const vs = user.verify_status || 'approved';
  if (vs === 'pending') return err('你的账号正在审核中，请等待运营验证，通过后即可登录', 403);
  if (vs === 'rejected') return err('你的注册申请未通过审核，如有疑问请联系运营', 403);

  const token = await signJWT({
    user_id: user.id,
    role: user.role,
    username: user.username,
    display_name: user.display_name || user.username,
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRE,
  }, env.SECRET_KEY);

  return new Response(JSON.stringify({
    id: user.id,
    role: user.role,
    username: user.username,
    display_name: user.display_name || user.username,
    xhs_avatar: user.xhs_avatar || '',
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setSessionCookie(token),
    },
  });
}

// POST /api/auth/register
export async function handleRegister(request, env) {
  const data = await parseBody(request);
  const display_name = (data.display_name || '').trim();
  const xhs_profile_url = (data.xhs_profile_url || '').trim();
  const xhs_screenshot = (data.xhs_screenshot || '').trim();
  const password = data.password || '';

  if (!display_name) return err('请填写小红书昵称');
  if (!xhs_profile_url) return err('请填写小红书主页链接');
  if (!xhs_screenshot) return err('请上传小红书主页截图');
  if (!password) return err('请设置登录密码');
  if (password.length < 6) return err('密码至少6位');
  if (!xhs_profile_url.startsWith('http')) return err('主页链接格式不正确');

  const username = `creator_${Date.now()}`;
  const pwHash = await hashPassword(password);

  try {
    await env.DB.prepare(`
      INSERT INTO users (role, username, password, display_name, xhs_profile_url, xhs_screenshot, verify_status)
      VALUES ('creator', ?, ?, ?, ?, ?, 'pending')
    `).bind(username, pwHash, display_name, xhs_profile_url, xhs_screenshot).run();

    const user = await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username).first();

    const token = await signJWT({
      user_id: user.id,
      role: user.role,
      username: user.username,
      display_name: user.display_name,
      exp: Math.floor(Date.now() / 1000) + JWT_EXPIRE,
    }, env.SECRET_KEY);

    return new Response(JSON.stringify({
      id: user.id,
      role: user.role,
      username: user.username,
      display_name: user.display_name,
      verify_status: 'pending',
      message: '注册成功！运营将在 1-2 个工作日内审核你的账号，审核通过后即可登录',
    }), {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': setSessionCookie(token),
      },
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return err('该昵称已被注册', 409);
    throw e;
  }
}

// POST /api/auth/xhs_login （小红书UID登录，不调本地脚本）
export async function handleXhsLogin(request, env) {
  const data = await parseBody(request);
  const link = (data.link || '').trim();
  if (!link) return err('请输入小红书主页链接');

  const m = link.match(/\/user\/profile\/([a-f0-9]+)/);
  const uid = m ? m[1] : link.trim();

  let user = await env.DB.prepare("SELECT * FROM users WHERE xhs_uid=?").bind(uid).first();

  if (!user) {
    const username = `creator_${uid.slice(0, 16)}`;
    await env.DB.prepare(`
      INSERT OR IGNORE INTO users (role, username, display_name, xhs_uid, verify_status)
      VALUES ('creator', ?, ?, ?, 'pending')
    `).bind(username, uid, uid).run();
    user = await env.DB.prepare("SELECT * FROM users WHERE xhs_uid=?").bind(uid).first();
  }

  const token = await signJWT({
    user_id: user.id,
    role: user.role,
    username: user.username,
    display_name: user.display_name || uid,
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRE,
  }, env.SECRET_KEY);

  return new Response(JSON.stringify({
    id: user.id,
    role: user.role,
    username: user.username,
    display_name: user.display_name || uid,
    xhs_uid: uid,
    xhs_avatar: user.xhs_avatar || '',
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setSessionCookie(token),
    },
  });
}

// GET /api/auth/me
export async function handleMe(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return json({ logged_in: false });
  return json({
    logged_in: true,
    id: user.user_id,
    role: user.role,
    username: user.username,
    display_name: user.display_name,
  });
}

// POST /api/auth/logout
export async function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
}
