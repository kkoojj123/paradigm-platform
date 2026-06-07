// ===== 运营后台 API =====
import { json, err, parseBody } from './utils.js';
import { getCurrentUser } from './auth.js';

// GET /api/admin/users
export async function handleAdminGetUsers(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('Operator permission required', 403);

  const url = new URL(request.url);
  const role = url.searchParams.get('role') || '';
  const verifyStatus = url.searchParams.get('verify_status') || '';

  let sql = `SELECT u.id, u.username, u.display_name, u.role, u.company, u.created_at,
    u.xhs_profile_url, u.xhs_screenshot, u.verify_status, u.verify_note, u.verified_at,
    u.xhs_uid, u.xhs_avatar,
    (SELECT COUNT(*) FROM submissions s WHERE s.user_id=u.id) as sub_count,
    (SELECT MAX(s.created_at) FROM submissions s WHERE s.user_id=u.id) as last_sub_at
    FROM users u WHERE u.role != 'operator'`;
  const params = [];

  if (role) { sql += ' AND u.role=?'; params.push(role); }
  if (verifyStatus) { sql += ' AND u.verify_status=?'; params.push(verifyStatus); }
  sql += ' ORDER BY u.created_at DESC';

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json(results || []);
}

// PUT /api/admin/users/:id/verify
export async function handleVerifyUser(request, env, userId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('Operator permission required', 403);

  const data = await parseBody(request);
  const status = data.status;
  const note = data.note || '';
  if (!['approved', 'rejected'].includes(status)) return err('Invalid status');

  await env.DB.prepare(
    "UPDATE users SET verify_status=?, verify_note=?, verified_at=datetime('now') WHERE id=? AND role='creator'"
  ).bind(status, note, userId).run();
  return json({ ok: true });
}

// GET /api/users (运营查看所有创作者)
export async function handleGetUsers(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('Operator permission required', 403);

  const { results } = await env.DB.prepare(
    "SELECT id, role, username, display_name, xhs_uid, xhs_avatar, company, created_at FROM users WHERE role != 'operator' ORDER BY created_at DESC"
  ).all();
  return json(results || []);
}

// GET /api/hot_notes
export async function handleGetHotNotes(request, env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM hot_notes ORDER BY likes DESC"
  ).all();
  return json(results || []);
}

// POST /api/hot_notes/refresh（运营手动添加热点笔记）
export async function handleRefreshHotNotes(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('Operator permission required', 403);

  const data = await parseBody(request);
  const notes = data.notes || [];

  for (const note of notes) {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO hot_notes (note_id, title, cover, likes, author, game_ip)
      VALUES (?,?,?,?,?,?)
    `).bind(
      note.note_id || '',
      note.title || '',
      note.cover || '',
      parseInt(note.likes || 0),
      note.author || '',
      note.game_ip || '',
    ).run();
  }
  return json({ ok: true, count: notes.length });
}

// GET /api/fetch_note （拉取小红书笔记基本信息）
// 在 CF Workers 环境无法调用本地脚本，改为尝试直接请求小红书 API
// 如果失败返回空数据（前端会降级处理）
export async function handleFetchNote(request, env) {
  const url = new URL(request.url);
  const noteId = (url.searchParams.get('note_id') || '').trim();
  if (!noteId) return err('缺少note_id');

  try {
    // 尝试通过小红书 web API 获取笔记信息（需要 SSO cookie）
    const resp = await fetch(`https://www.xiaohongshu.com/explore/${noteId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.xiaohongshu.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (resp.ok) {
      const html = await resp.text();
      // 从 HTML 里提取 __INITIAL_STATE__ 或 og:title/og:image
      const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
      const imgMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      const title = titleMatch ? titleMatch[1].replace(' - 小红书', '').trim() : '';
      const cover = imgMatch ? imgMatch[1] : '';

      return json({
        note_id: noteId,
        title,
        cover,
        likes: 0,
        collects: 0,
        author: '',
        avatar: '',
      });
    }
  } catch (e) {
    // 忽略错误，返回空数据
  }

  // 降级：返回空数据，前端手动填写
  return json({
    note_id: noteId,
    title: '',
    cover: '',
    likes: 0,
    collects: 0,
    author: '',
    avatar: '',
    error: 'Cannot fetch note info, please fill manually',
  });
}

// GET /api/proxy_image （图片代理，解决跨域）
export async function handleProxyImage(request, env) {
  const url = new URL(request.url);
  const imgUrl = (url.searchParams.get('url') || '').trim();
  if (!imgUrl || !imgUrl.startsWith('http')) return new Response('', { status: 400 });

  try {
    const resp = await fetch(imgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.xiaohongshu.com/',
      },
    });
    const data = await resp.arrayBuffer();
    const ct = resp.headers.get('Content-Type') || 'image/jpeg';
    return new Response(data, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response('', { status: 502 });
  }
}

// POST /api/upload （图片转 base64 存储，无需 R2）
export async function handleUpload(request, env) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return err('No file');

  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  if (!allowed.includes(file.type)) return err('Unsupported file type');

  // 限制 5MB
  if (file.size > 5 * 1024 * 1024) return err('Image must be under 5MB');

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  const dataUrl = `data:${file.type};base64,${base64}`;

  return json({ url: dataUrl, filename: file.name });
}
