// ===== 选题 CRUD =====
import { json, err, parseBody, serializeTopic, extractNoteId } from './utils.js';
import { getCurrentUser } from './auth.js';

// GET /api/topics
export async function handleGetTopics(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || '';
  const source = url.searchParams.get('source') || '';
  const user = await getCurrentUser(request, env);
  const showAll = url.searchParams.get('all') === '1' && user?.role === 'operator';

  let sql = `SELECT t.*, u.display_name as creator_name,
    (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as submission_count
    FROM topics t LEFT JOIN users u ON t.created_by=u.id
    WHERE `;

  const params = [];
  sql += showAll ? '1=1' : "t.status IN ('published','offline')";

  if (type) { sql += ' AND t.type=?'; params.push(type); }
  if (source) { sql += ' AND t.source=?'; params.push(source); }
  sql += ' ORDER BY t.created_at DESC';

  const stmt = env.DB.prepare(sql);
  const { results } = params.length
    ? await stmt.bind(...params).all()
    : await stmt.all();

  return json((results || []).map(serializeTopic));
}

// GET /api/topics/:id
export async function handleGetTopic(request, env, topicId) {
  const row = await env.DB.prepare(`
    SELECT t.*, u.display_name as creator_name,
    (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as sub_count
    FROM topics t LEFT JOIN users u ON t.created_by=u.id WHERE t.id=?
  `).bind(topicId).first();
  if (!row) return err('不存在', 404);
  return json(serializeTopic(row));
}

// POST /api/topics
export async function handleCreateTopic(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err('请先登录', 401);

  const data = await parseBody(request);
  const title = (data.title || '').trim();
  if (!title) return err('标题不能为空');

  const status = user.role === 'operator' ? 'published' : 'pending';
  const source = user.role || 'creator';

  const result = await env.DB.prepare(`
    INSERT INTO topics (type, title, description, benefits, reward_amount, reward_rules,
      ref_notes, requirements, directions, source, status, created_by, cover_url, deadline)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    data.type || 'topic',
    title,
    data.description || '',
    data.benefits || '',
    parseInt(data.reward_amount || 0),
    data.reward_rules || '',
    JSON.stringify(data.ref_notes || []),
    data.requirements || '',
    JSON.stringify(data.directions || []),
    source,
    status,
    user.user_id,
    data.cover_url || '',
    data.deadline || '',
  ).run();

  const row = await env.DB.prepare("SELECT * FROM topics WHERE id=?").bind(result.meta.last_row_id).first();
  return json(serializeTopic(row), 201);
}

// PUT /api/topics/:id
export async function handleUpdateTopic(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('无权限', 403);

  const data = await parseBody(request);
  const row = await env.DB.prepare("SELECT id FROM topics WHERE id=?").bind(topicId).first();
  if (!row) return err('选题不存在', 404);

  const fields = [];
  const vals = [];
  for (const key of ['title', 'description', 'requirements', 'source', 'type', 'cover_url', 'deadline', 'participant_count', 'benefits', 'reward_amount', 'reward_rules']) {
    if (key in data) { fields.push(`${key}=?`); vals.push(data[key]); }
  }
  if ('ref_notes' in data) { fields.push('ref_notes=?'); vals.push(JSON.stringify(data.ref_notes)); }
  if ('directions' in data) { fields.push('directions=?'); vals.push(JSON.stringify(data.directions)); }

  if (fields.length) {
    vals.push(topicId);
    await env.DB.prepare(`UPDATE topics SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
  }
  return json({ ok: true });
}

// PUT /api/topics/:id/status
export async function handleUpdateTopicStatus(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('需要运营权限', 403);

  const data = await parseBody(request);
  const status = data.status;
  if (!['published', 'pending', 'offline'].includes(status)) return err('无效状态');

  await env.DB.prepare("UPDATE topics SET status=? WHERE id=?").bind(status, topicId).run();
  return json({ ok: true });
}

// DELETE /api/topics/:id  &  DELETE /api/admin/topics/:id
export async function handleDeleteTopic(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('无权限', 403);

  await env.DB.prepare("DELETE FROM topics WHERE id=?").bind(topicId).run();
  return json({ ok: true });
}

// GET /api/admin/topics
export async function handleAdminGetTopics(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('需要运营权限', 403);

  const { results } = await env.DB.prepare(`
    SELECT t.*, u.display_name as creator_name,
      (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as sub_count,
      (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='pending') as sub_pending,
      (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='approved') as sub_approved,
      (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='rejected') as sub_rejected,
      (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.submit_type='draft') as sub_draft,
      (SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.submit_type='existing') as sub_existing
    FROM topics t LEFT JOIN users u ON t.created_by=u.id
    ORDER BY t.created_at DESC
  `).all();

  return json((results || []).map(serializeTopic));
}

// POST /api/topics/:id/add_notes （运营添加已有投稿笔记）
export async function handleAddNotes(request, env, topicId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('需要运营权限', 403);

  const data = await parseBody(request);
  const notes = data.notes || [];
  if (!notes.length) return err('没有笔记数据');

  const added = [];
  const skipped = [];

  for (const note of notes) {
    const noteId = note.note_id || '';
    // 按 note_id 判重
    const dup = await env.DB.prepare(
      "SELECT id FROM submissions WHERE topic_id=? AND note_id=?"
    ).bind(topicId, noteId).first();

    if (dup) { skipped.push(noteId); continue; }

    await env.DB.prepare(`
      INSERT INTO submissions
      (topic_id, user_id, note_id, note_title, cover_url, likes,
       submit_type, creator_name, status, submission_number)
      VALUES (?,?,?,?,?,?,?,?,'approved',1)
    `).bind(
      topicId,
      user.user_id,
      noteId,
      note.title || '',
      note.cover || '',
      parseInt(note.likes || 0),
      'existing',
      note.author || '',
    ).run();
    added.push(noteId);
  }

  return json({ ok: true, added: added.length, skipped: skipped.length });
}
