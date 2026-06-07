// ===== 工具函数 =====

// SHA-256 密码哈希（Web Crypto API）
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// JWT 生成与验证（HMAC-SHA256）
export async function signJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${signingInput}.${sigB64}`;
}

export async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const signingInput = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(signingInput));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// 从 Cookie 中读取 session
export function getSessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}

// 设置 session Cookie
export function setSessionCookie(token, maxAge = 7 * 24 * 3600) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// 清除 session Cookie
export function clearSessionCookie() {
  return `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// JSON 响应
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// 错误响应
export function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// 解析 JSON body
export async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// 解析 JSON 字段（兼容双重编码）
export function parseJsonField(val, fallback = []) {
  if (Array.isArray(val) || (val && typeof val === 'object')) return val;
  if (!val) return fallback;
  try {
    let parsed = JSON.parse(val);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed;
  } catch {
    return fallback;
  }
}

// 序列化 topic（JSON字段展开）
export function serializeTopic(row) {
  const d = { ...row };
  for (const field of ['ref_notes', 'directions']) {
    d[field] = parseJsonField(d[field], []);
  }
  if (Array.isArray(d.directions)) {
    for (const dir of d.directions) {
      if (dir && typeof dir === 'object' && !('notes' in dir)) {
        dir.notes = dir.ref_notes || [];
      }
    }
  }
  return d;
}

// 从小红书笔记链接提取 note_id
export function extractNoteId(link) {
  const m = link.match(/\/explore\/([a-f0-9]+)/);
  return m ? m[1] : link.trim();
}

// CORS 头（开发时用，生产可收紧）
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
