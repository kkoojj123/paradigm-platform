// ===== 投稿管理 =====
import { json, err, parseBody, extractNoteId } from './utils.js';
import { getCurrentUser } from './auth.js';

// GET /api/submissions
export async function handleGetSubmissions(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err('请先登录', 401);

  const url = new URL(request.url);
  const topicId = url.searchParams.get('topic_id');

  let sql, params;

  if (user.role === 'operator') {
    if (topicId) {
      sql = `SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
             FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id
             WHERE s.topic_id=? ORDER BY s.created_at DESC`;
      params = [topicId];
    } else {
      sql = `SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
             FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id
             ORDER BY s.created_at DESC`;
      params = [];
    }
  } else {
    if (topicId) {
      sql = `SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
             FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id
             WHERE s.user_id=? AND s.topic_id=? ORDER BY s.created_at DESC`;
      params = [user.user_id, topicId];
    } else {
      sql = `SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name, t.title as topic_title
             FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id
             WHERE s.user_id=? ORDER BY s.created_at DESC`;
      params = [user.user_id];
    }
  }

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json(results || []);
}

// GET /api/topics/:id/approved-submissions
export async function handleGetApprovedSubmissions(request, env, topicId) {
  const { results } = await env.DB.prepare(`
    SELECT s.*, COALESCE(s.creator_name, u.display_name, '匿名') as creator_name
    FROM submissions s LEFT JOIN users u ON s.user_id=u.id
    WHERE s.topic_id=? AND s.status='approved'
    ORDER BY s.created_at DESC
  `).bind(topicId).all();
  return json(results || []);
}

// POST /api/submissions
export async function handleCreateSubmission(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) return err('请先登录', 401);

  const data = await parseBody(request);
  const topicId = data.topic_id;
  const submitType = data.submit_type || 'existing';
  if (!topicId) return err('缺少topic_id');

  let noteId = '', noteLink = '', realName = '', profileLink = '', contact = '', draftContent = '';

  if (submitType === 'existing') {
    noteLink = (data.note_link || '').trim();
    realName = (data.real_name || '').trim();
    profileLink = (data.profile_link || '').trim();
    if (!noteLink) return err('请填写笔记链接');
    noteId = extractNoteId(noteLink);
  } else {
    profileLink = (data.profile_link || '').trim();
    contact = (data.contact || '').trim();
    draftContent = (data.draft_content || '').trim();
    if (!profileLink || !draftContent) return err('请填写主页链接和脚本思路');
    realName = data.real_name || '';
  }

  // 运营添加按 note_id 判重
  if (user.role === 'operator' && submitType === 'existing') {
    const dup = await env.DB.prepare(
      "SELECT id FROM submissions WHERE topic_id=? AND note_id=?"
    ).bind(topicId, noteId).first();
    if (dup) return err('该笔记已添加过', 409);
  }

  // 计算第几次提交
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM submissions WHERE topic_id=? AND user_id=?"
  ).bind(topicId, user.user_id).first();
  const submissionNumber = (countRow?.cnt || 0) + 1;

  const result = await env.DB.prepare(`
    INSERT INTO submissions
    (topic_id, user_id, note_id, note_title, cover_url, likes,
     submit_type, note_link, profile_link, contact, real_name, draft_content,
     review_status, status, created_at, submission_number, creator_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?)
  `).bind(
    topicId, user.user_id,
    noteId,
    data.note_title || '',
    data.cover_url || '',
    parseInt(data.likes || 0),
    submitType,
    submitType === 'existing' ? noteLink : '',
    profileLink,
    contact,
    realName,
    submitType === 'draft' ? draftContent : '',
    data.status === 'approved' ? 'approved' : 'pending',
    data.status || 'pending',
    submissionNumber,
    data.creator_name || user.display_name || '',
  ).run();

  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(result.meta.last_row_id).first();
  return json(row, 201);
}

// PUT /api/submissions/:id
export async function handleUpdateSubmission(request, env, subId) {
  const user = await getCurrentUser(request, env);
  if (!user) return err('请先登录', 401);

  const data = await parseBody(request);
  const isOperator = user.role === 'operator';

  const sub = await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(subId).first();
  if (!sub) return err('投稿不存在', 404);
  if (sub.user_id !== user.user_id && !isOperator) return err('无权限', 403);

  const status = data.status || sub.status;
  const reviewNote = data.review_note !== undefined ? data.review_note : sub.review_note;

  if (sub.submit_type === 'existing') {
    const noteLink = (data.note_link || '').trim();
    const noteId = noteLink ? extractNoteId(noteLink) : sub.note_id;
    await env.DB.prepare(`
      UPDATE submissions SET note_id=?, note_link=?, profile_link=?,
      note_title=?, cover_url=?, likes=?, status=?, review_note=?,
      creator_name=?, reviewed_at=datetime('now') WHERE id=?
    `).bind(
      noteId, noteLink || sub.note_link,
      data.profile_link !== undefined ? data.profile_link : sub.profile_link,
      data.note_title !== undefined ? data.note_title : sub.note_title,
      data.cover_url !== undefined ? data.cover_url : sub.cover_url,
      parseInt(data.likes !== undefined ? data.likes : sub.likes),
      status, reviewNote,
      data.creator_name !== undefined ? data.creator_name : sub.creator_name,
      subId
    ).run();
  } else {
    await env.DB.prepare(`
      UPDATE submissions SET profile_link=?, contact=?, draft_content=?,
      status=?, review_note=?, reviewed_at=datetime('now') WHERE id=?
    `).bind(
      data.profile_link || sub.profile_link,
      data.contact !== undefined ? data.contact : sub.contact,
      data.draft_content || sub.draft_content,
      status, reviewNote, subId
    ).run();
  }

  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(subId).first();
  return json(row);
}

// PUT /api/submissions/:id/status
export async function handleUpdateSubmissionStatus(request, env, subId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('需要运营权限', 403);

  const data = await parseBody(request);
  const status = data.status;
  if (!['approved', 'rejected', 'pending'].includes(status)) return err('无效状态');

  await env.DB.prepare(
    "UPDATE submissions SET status=?, reviewed_at=datetime('now'), review_note=? WHERE id=?"
  ).bind(status, data.review_note || '', subId).run();
  return json({ ok: true });
}

// PUT /api/submissions/:id/suggestion
export async function handleAddSuggestion(request, env, subId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('需要运营权限', 403);

  const data = await parseBody(request);
  const suggestion = data.suggestion || '';
  if (!suggestion) return err('建议内容不能为空');

  const row = await env.DB.prepare("SELECT review_note FROM submissions WHERE id=?").bind(subId).first();
  const existing = row?.review_note || '';
  const newNote = existing ? `${existing}\n\n--- 补充建议 ---\n${suggestion}` : suggestion;
  await env.DB.prepare("UPDATE submissions SET review_note=? WHERE id=?").bind(newNote, subId).run();
  return json({ ok: true });
}

// DELETE /api/submissions/:id
export async function handleDeleteSubmission(request, env, subId) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('需要运营权限', 403);

  await env.DB.prepare("DELETE FROM submissions WHERE id=?").bind(subId).run();
  return json({ ok: true });
}

// GET /api/submissions/export （CSV下载）
export async function handleExportSubmissions(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || user.role !== 'operator') return err('需要运营权限', 403);

  const { results } = await env.DB.prepare(`
    SELECT s.id, s.note_id, s.note_title, s.likes, s.status, s.created_at, s.reviewed_at,
           COALESCE(s.creator_name, u.display_name, '匿名') as creator_name,
           u.xhs_uid, t.title as topic_title, t.type as topic_type
    FROM submissions s
    LEFT JOIN users u ON s.user_id=u.id
    LEFT JOIN topics t ON s.topic_id=t.id
    ORDER BY s.created_at DESC
  `).all();

  const rows = results || [];
  const header = ['ID','笔记ID','笔记标题','点赞数','状态','创作者','XHS UID','选题','类型','投稿时间','审核时间'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.note_id,
      `"${(r.note_title || '').replace(/"/g, '""')}"`,
      r.likes, r.status,
      `"${(r.creator_name || '').replace(/"/g, '""')}"`,
      r.xhs_uid || '',
      `"${(r.topic_title || '').replace(/"/g, '""')}"`,
      r.topic_type || '', r.created_at || '', r.reviewed_at || ''
    ].join(','));
  }
  const csv = '\uFEFF' + lines.join('\n'); // BOM for Excel

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="submissions.csv"',
    },
  });
}
