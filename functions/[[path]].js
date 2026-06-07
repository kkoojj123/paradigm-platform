// ===== Cloudflare Pages Functions - All-in-one API handler =====
// 捕获所有 /api/* 请求，处理完整后端逻辑

// ===== UTILS =====
async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function signJWT(payload, secret) {
  const header = btoa(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const body = btoa(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function verifyJWT(token, secret) {
  try {
    const [h,b,s] = token.split('.');
    if (!h||!b||!s) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(s),c=>c.charCodeAt(0)), new TextEncoder().encode(`${h}.${b}`));
    if (!valid) return null;
    const p = JSON.parse(atob(b));
    if (p.exp && Date.now()/1000 > p.exp) return null;
    return p;
  } catch { return null; }
}

function getToken(req) {
  const c = req.headers.get('Cookie')||'';
  const m = c.match(/(?:^|;\s*)session=([^;]+)/);
  return m?m[1]:null;
}

function setCookie(token, max=7*24*3600) {
  return `session=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${max}`;
}

function clearCookie() {
  return `session=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`;
}

function j(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json',...extra}});
}

function e(msg, status=400) { return j({error:msg}, status); }

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

function parseJSON(v, fb=[]) {
  if (Array.isArray(v)||(v&&typeof v==='object')) return v;
  if (!v) return fb;
  try { let p=JSON.parse(v); if(typeof p==='string') p=JSON.parse(p); return p; } catch { return fb; }
}

function serializeTopic(row) {
  const d={...row};
  for (const f of ['ref_notes','directions']) d[f]=parseJSON(d[f],[]);
  if (Array.isArray(d.directions)) for (const dir of d.directions) if(dir&&!('notes' in dir)) dir.notes=dir.ref_notes||[];
  return d;
}

function noteId(link) {
  const m=link.match(/\/explore\/([a-f0-9]+)/);
  return m?m[1]:link.trim();
}

async function getUser(req, env) {
  const t=getToken(req);
  if (!t) return null;
  return verifyJWT(t, env.SECRET_KEY);
}

const JWT_EXP = 7*24*3600;

// ===== AUTH =====
async function login(req, env) {
  const d=await body(req);
  const un=(d.username||'').trim(), pw=d.password||'';
  if (!un||!pw) return e('Username and password required');
  const h=await hashPassword(pw);
  let u=await env.DB.prepare("SELECT * FROM users WHERE username=? AND password=?").bind(un,h).first();
  if (!u) u=await env.DB.prepare("SELECT * FROM users WHERE display_name=? AND password=?").bind(un,h).first();
  if (!u) return e('Invalid username or password',401);
  const vs=u.verify_status||'approved';
  if (vs==='pending') return e('Account under review, please wait for approval',403);
  if (vs==='rejected') return e('Registration rejected, please contact admin',403);
  const token=await signJWT({user_id:u.id,role:u.role,username:u.username,display_name:u.display_name||u.username,exp:Math.floor(Date.now()/1000)+JWT_EXP},env.SECRET_KEY);
  return new Response(JSON.stringify({id:u.id,role:u.role,username:u.username,display_name:u.display_name||u.username,xhs_avatar:u.xhs_avatar||''}),{status:200,headers:{'Content-Type':'application/json','Set-Cookie':setCookie(token)}});
}

async function register(req, env) {
  const d=await body(req);
  const dn=(d.display_name||'').trim(), pu=(d.xhs_profile_url||'').trim(), ss=(d.xhs_screenshot||'').trim(), pw=d.password||'';
  if (!dn) return e('Please fill in your XHS nickname');
  if (!pu) return e('Please fill in your XHS profile URL');
  if (!ss) return e('Please upload your XHS profile screenshot');
  if (!pw) return e('Please set a password');
  if (pw.length<6) return e('Password must be at least 6 characters');
  if (!pu.startsWith('http')) return e('Invalid profile URL format');
  const un=`creator_${Date.now()}`, h=await hashPassword(pw);
  try {
    await env.DB.prepare("INSERT INTO users (role,username,password,display_name,xhs_profile_url,xhs_screenshot,verify_status) VALUES ('creator',?,?,?,?,?,'pending')").bind(un,h,dn,pu,ss).run();
    const u=await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(un).first();
    const token=await signJWT({user_id:u.id,role:u.role,username:u.username,display_name:u.display_name,exp:Math.floor(Date.now()/1000)+JWT_EXP},env.SECRET_KEY);
    return new Response(JSON.stringify({id:u.id,role:u.role,username:u.username,display_name:u.display_name,verify_status:'pending',message:'Registration successful! Please wait 1-2 business days for approval'}),{status:201,headers:{'Content-Type':'application/json','Set-Cookie':setCookie(token)}});
  } catch(err) {
    if (err.message&&err.message.includes('UNIQUE')) return e('Nickname already registered',409);
    throw err;
  }
}

async function xhsLogin(req, env) {
  const d=await body(req);
  const link=(d.link||'').trim();
  if (!link) return e('Please enter your XHS profile URL');
  const m=link.match(/\/user\/profile\/([a-f0-9]+)/);
  const uid=m?m[1]:link.trim();
  let u=await env.DB.prepare("SELECT * FROM users WHERE xhs_uid=?").bind(uid).first();
  if (!u) {
    const un=`creator_${uid.slice(0,16)}`;
    await env.DB.prepare("INSERT OR IGNORE INTO users (role,username,display_name,xhs_uid,verify_status) VALUES ('creator',?,?,?,'pending')").bind(un,uid,uid).run();
    u=await env.DB.prepare("SELECT * FROM users WHERE xhs_uid=?").bind(uid).first();
  }
  const token=await signJWT({user_id:u.id,role:u.role,username:u.username,display_name:u.display_name||uid,exp:Math.floor(Date.now()/1000)+JWT_EXP},env.SECRET_KEY);
  return new Response(JSON.stringify({id:u.id,role:u.role,username:u.username,display_name:u.display_name||uid,xhs_uid:uid,xhs_avatar:u.xhs_avatar||''}),{status:200,headers:{'Content-Type':'application/json','Set-Cookie':setCookie(token)}});
}

async function me(req, env) {
  const u=await getUser(req,env);
  if (!u) return j({logged_in:false});
  return j({logged_in:true,id:u.user_id,role:u.role,username:u.username,display_name:u.display_name});
}

function logout() {
  return new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json','Set-Cookie':clearCookie()}});
}

// ===== TOPICS =====
async function getTopics(req, env) {
  const url=new URL(req.url), type=url.searchParams.get('type')||'', source=url.searchParams.get('source')||'';
  const u=await getUser(req,env);
  const all=url.searchParams.get('all')==='1'&&u?.role==='operator';
  let sql=`SELECT t.*,u.display_name as creator_name,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as submission_count FROM topics t LEFT JOIN users u ON t.created_by=u.id WHERE `;
  const p=[];
  sql+=all?'1=1':"t.status IN ('published','offline')";
  if (type){sql+=' AND t.type=?';p.push(type);}
  if (source){sql+=' AND t.source=?';p.push(source);}
  sql+=' ORDER BY t.created_at DESC';
  const {results}=p.length?await env.DB.prepare(sql).bind(...p).all():await env.DB.prepare(sql).all();
  return j((results||[]).map(serializeTopic));
}

async function getTopic(req, env, id) {
  const row=await env.DB.prepare("SELECT t.*,u.display_name as creator_name,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as sub_count FROM topics t LEFT JOIN users u ON t.created_by=u.id WHERE t.id=?").bind(id).first();
  if (!row) return e('Not found',404);
  return j(serializeTopic(row));
}

async function createTopic(req, env) {
  const u=await getUser(req,env);
  if (!u) return e('Please login first',401);
  const d=await body(req);
  const title=(d.title||'').trim();
  if (!title) return e('Title is required');
  const status=u.role==='operator'?'published':'pending';
  const r=await env.DB.prepare("INSERT INTO topics (type,title,description,benefits,reward_amount,reward_rules,ref_notes,requirements,directions,source,status,created_by,cover_url,deadline) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(d.type||'topic',title,d.description||'',d.benefits||'',parseInt(d.reward_amount||0),d.reward_rules||'',JSON.stringify(d.ref_notes||[]),d.requirements||'',JSON.stringify(d.directions||[]),u.role||'creator',status,u.user_id,d.cover_url||'',d.deadline||'').run();
  const row=await env.DB.prepare("SELECT * FROM topics WHERE id=?").bind(r.meta.last_row_id).first();
  return j(serializeTopic(row),201);
}

async function updateTopic(req, env, id) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Forbidden',403);
  const d=await body(req);
  const fields=[],vals=[];
  for (const k of ['title','description','requirements','source','type','cover_url','deadline','participant_count','benefits','reward_amount','reward_rules']) if (k in d){fields.push(`${k}=?`);vals.push(d[k]);}
  if ('ref_notes' in d){fields.push('ref_notes=?');vals.push(JSON.stringify(d.ref_notes));}
  if ('directions' in d){fields.push('directions=?');vals.push(JSON.stringify(d.directions));}
  if (fields.length){vals.push(id);await env.DB.prepare(`UPDATE topics SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();}
  return j({ok:true});
}

async function updateTopicStatus(req, env, id) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const d=await body(req);
  if (!['published','pending','offline'].includes(d.status)) return e('Invalid status');
  await env.DB.prepare("UPDATE topics SET status=? WHERE id=?").bind(d.status,id).run();
  return j({ok:true});
}

async function deleteTopic(req, env, id) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Forbidden',403);
  await env.DB.prepare("DELETE FROM topics WHERE id=?").bind(id).run();
  return j({ok:true});
}

async function adminGetTopics(req, env) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const {results}=await env.DB.prepare("SELECT t.*,u.display_name as creator_name,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id) as sub_count,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='pending') as sub_pending,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='approved') as sub_approved,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.status='rejected') as sub_rejected,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.submit_type='draft') as sub_draft,(SELECT COUNT(*) FROM submissions s WHERE s.topic_id=t.id AND s.submit_type='existing') as sub_existing FROM topics t LEFT JOIN users u ON t.created_by=u.id ORDER BY t.created_at DESC").all();
  return j((results||[]).map(serializeTopic));
}

async function addNotes(req, env, topicId) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const d=await body(req);
  const notes=d.notes||[];
  if (!notes.length) return e('No note data');
  let added=0,skipped=0;
  for (const n of notes) {
    const nid=n.note_id||'';
    const dup=await env.DB.prepare("SELECT id FROM submissions WHERE topic_id=? AND note_id=?").bind(topicId,nid).first();
    if (dup){skipped++;continue;}
    await env.DB.prepare("INSERT INTO submissions (topic_id,user_id,note_id,note_title,cover_url,likes,submit_type,creator_name,status,submission_number) VALUES (?,?,?,?,?,?,?,?,'approved',1)").bind(topicId,u.user_id,nid,n.title||'',n.cover||'',parseInt(n.likes||0),'existing',n.author||'').run();
    added++;
  }
  return j({ok:true,added,skipped});
}

// ===== SUBMISSIONS =====
async function getSubmissions(req, env) {
  const u=await getUser(req,env);
  if (!u) return e('Please login first',401);
  const url=new URL(req.url), tid=url.searchParams.get('topic_id');
  let sql,p;
  if (u.role==='operator') {
    if (tid){sql="SELECT s.*,COALESCE(s.creator_name,u.display_name,'anon') as creator_name,t.title as topic_title FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id WHERE s.topic_id=? ORDER BY s.created_at DESC";p=[tid];}
    else{sql="SELECT s.*,COALESCE(s.creator_name,u.display_name,'anon') as creator_name,t.title as topic_title FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id ORDER BY s.created_at DESC";p=[];}
  } else {
    if (tid){sql="SELECT s.*,COALESCE(s.creator_name,u.display_name,'anon') as creator_name,t.title as topic_title FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id WHERE s.user_id=? AND s.topic_id=? ORDER BY s.created_at DESC";p=[u.user_id,tid];}
    else{sql="SELECT s.*,COALESCE(s.creator_name,u.display_name,'anon') as creator_name,t.title as topic_title FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id WHERE s.user_id=? ORDER BY s.created_at DESC";p=[u.user_id];}
  }
  const {results}=p.length?await env.DB.prepare(sql).bind(...p).all():await env.DB.prepare(sql).all();
  return j(results||[]);
}

async function getApprovedSubs(req, env, topicId) {
  const {results}=await env.DB.prepare("SELECT s.*,COALESCE(s.creator_name,u.display_name,'anon') as creator_name FROM submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.topic_id=? AND s.status='approved' ORDER BY s.created_at DESC").bind(topicId).all();
  return j(results||[]);
}

async function createSub(req, env) {
  const u=await getUser(req,env);
  if (!u) return e('Please login first',401);
  const d=await body(req);
  const tid=d.topic_id, st=d.submit_type||'existing';
  if (!tid) return e('Missing topic_id');
  let nid='',nl='',rn='',pl='',ct='',dc='';
  if (st==='existing'){
    nl=(d.note_link||'').trim();rn=(d.real_name||'').trim();pl=(d.profile_link||'').trim();
    if (!nl) return e('Please fill in note link');
    nid=noteId(nl);
  } else {
    pl=(d.profile_link||'').trim();ct=(d.contact||'').trim();dc=(d.draft_content||'').trim();
    if (!pl||!dc) return e('Please fill in profile link and draft');
    rn=d.real_name||'';
  }
  if (u.role==='operator'&&st==='existing'){
    const dup=await env.DB.prepare("SELECT id FROM submissions WHERE topic_id=? AND note_id=?").bind(tid,nid).first();
    if (dup) return e('Note already added',409);
  }
  const cr=await env.DB.prepare("SELECT COUNT(*) as cnt FROM submissions WHERE topic_id=? AND user_id=?").bind(tid,u.user_id).first();
  const sn=(cr?.cnt||0)+1;
  const r=await env.DB.prepare("INSERT INTO submissions (topic_id,user_id,note_id,note_title,cover_url,likes,submit_type,note_link,profile_link,contact,real_name,draft_content,review_status,status,created_at,submission_number,creator_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?)").bind(tid,u.user_id,nid,d.note_title||'',d.cover_url||'',parseInt(d.likes||0),st,st==='existing'?nl:'',pl,ct,rn,st==='draft'?dc:'',d.status==='approved'?'approved':'pending',d.status||'pending',sn,d.creator_name||u.display_name||'').run();
  const row=await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(r.meta.last_row_id).first();
  return j(row,201);
}

async function updateSub(req, env, sid) {
  const u=await getUser(req,env);
  if (!u) return e('Please login first',401);
  const d=await body(req);
  const sub=await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(sid).first();
  if (!sub) return e('Submission not found',404);
  if (sub.user_id!==u.user_id&&u.role!=='operator') return e('Forbidden',403);
  const st=d.status||sub.status, rn=d.review_note!==undefined?d.review_note:sub.review_note;
  if (sub.submit_type==='existing'){
    const nl=(d.note_link||'').trim(), nid=nl?noteId(nl):sub.note_id;
    await env.DB.prepare("UPDATE submissions SET note_id=?,note_link=?,profile_link=?,note_title=?,cover_url=?,likes=?,status=?,review_note=?,creator_name=?,reviewed_at=datetime('now') WHERE id=?").bind(nid,nl||sub.note_link,d.profile_link!==undefined?d.profile_link:sub.profile_link,d.note_title!==undefined?d.note_title:sub.note_title,d.cover_url!==undefined?d.cover_url:sub.cover_url,parseInt(d.likes!==undefined?d.likes:sub.likes),st,rn,d.creator_name!==undefined?d.creator_name:sub.creator_name,sid).run();
  } else {
    await env.DB.prepare("UPDATE submissions SET profile_link=?,contact=?,draft_content=?,status=?,review_note=?,reviewed_at=datetime('now') WHERE id=?").bind(d.profile_link||sub.profile_link,d.contact!==undefined?d.contact:sub.contact,d.draft_content||sub.draft_content,st,rn,sid).run();
  }
  return j(await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(sid).first());
}

async function updateSubStatus(req, env, sid) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const d=await body(req);
  if (!['approved','rejected','pending'].includes(d.status)) return e('Invalid status');
  await env.DB.prepare("UPDATE submissions SET status=?,reviewed_at=datetime('now'),review_note=? WHERE id=?").bind(d.status,d.review_note||'',sid).run();
  return j({ok:true});
}

async function addSuggestion(req, env, sid) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const d=await body(req);
  if (!d.suggestion) return e('Suggestion cannot be empty');
  const row=await env.DB.prepare("SELECT review_note FROM submissions WHERE id=?").bind(sid).first();
  const existing=row?.review_note||'';
  await env.DB.prepare("UPDATE submissions SET review_note=? WHERE id=?").bind(existing?`${existing}\n\n---\n${d.suggestion}`:d.suggestion,sid).run();
  return j({ok:true});
}

async function deleteSub(req, env, sid) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  await env.DB.prepare("DELETE FROM submissions WHERE id=?").bind(sid).run();
  return j({ok:true});
}

async function exportSubs(req, env) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const {results}=await env.DB.prepare("SELECT s.id,s.note_id,s.note_title,s.likes,s.status,s.created_at,s.reviewed_at,COALESCE(s.creator_name,u.display_name,'anon') as creator_name,u.xhs_uid,t.title as topic_title,t.type as topic_type FROM submissions s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN topics t ON s.topic_id=t.id ORDER BY s.created_at DESC").all();
  const rows=results||[];
  const lines=[['ID','NoteID','Title','Likes','Status','Creator','XHS_UID','Topic','Type','Created','Reviewed'].join(',')];
  for (const r of rows) lines.push([r.id,r.note_id,`"${(r.note_title||'').replace(/"/g,'""')}"`,r.likes,r.status,`"${(r.creator_name||'').replace(/"/g,'""')}"`,r.xhs_uid||'',`"${(r.topic_title||'').replace(/"/g,'""')}"`,r.topic_type||'',r.created_at||'',r.reviewed_at||''].join(','));
  return new Response('\uFEFF'+lines.join('\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="submissions.csv"'}});
}

// ===== ADMIN =====
async function adminGetUsers(req, env) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const url=new URL(req.url), role=url.searchParams.get('role')||'', vs=url.searchParams.get('verify_status')||'';
  let sql="SELECT u.id,u.username,u.display_name,u.role,u.company,u.created_at,u.xhs_profile_url,u.xhs_screenshot,u.verify_status,u.verify_note,u.verified_at,u.xhs_uid,u.xhs_avatar,(SELECT COUNT(*) FROM submissions s WHERE s.user_id=u.id) as sub_count,(SELECT MAX(s.created_at) FROM submissions s WHERE s.user_id=u.id) as last_sub_at FROM users u WHERE u.role != 'operator'";
  const p=[];
  if (role){sql+=' AND u.role=?';p.push(role);}
  if (vs){sql+=' AND u.verify_status=?';p.push(vs);}
  sql+=' ORDER BY u.created_at DESC';
  const {results}=p.length?await env.DB.prepare(sql).bind(...p).all():await env.DB.prepare(sql).all();
  return j(results||[]);
}

async function verifyUser(req, env, uid) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const d=await body(req);
  if (!['approved','rejected'].includes(d.status)) return e('Invalid status');
  await env.DB.prepare("UPDATE users SET verify_status=?,verify_note=?,verified_at=datetime('now') WHERE id=? AND role='creator'").bind(d.status,d.note||'',uid).run();
  return j({ok:true});
}

async function getUsers(req, env) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const {results}=await env.DB.prepare("SELECT id,role,username,display_name,xhs_uid,xhs_avatar,company,created_at FROM users WHERE role != 'operator' ORDER BY created_at DESC").all();
  return j(results||[]);
}

async function getHotNotes(env) {
  const {results}=await env.DB.prepare("SELECT * FROM hot_notes ORDER BY likes DESC").all();
  return j(results||[]);
}

async function refreshHotNotes(req, env) {
  const u=await getUser(req,env);
  if (!u||u.role!=='operator') return e('Operator required',403);
  const d=await body(req);
  for (const n of (d.notes||[])) await env.DB.prepare("INSERT OR REPLACE INTO hot_notes (note_id,title,cover,likes,author,game_ip) VALUES (?,?,?,?,?,?)").bind(n.note_id||'',n.title||'',n.cover||'',parseInt(n.likes||0),n.author||'',n.game_ip||'').run();
  return j({ok:true,count:(d.notes||[]).length});
}

async function fetchNote(req) {
  const url=new URL(req.url), nid=(url.searchParams.get('note_id')||'').trim();
  if (!nid) return e('Missing note_id');
  try {
    const resp=await fetch(`https://www.xiaohongshu.com/explore/${nid}`,{headers:{'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15','Referer':'https://www.xiaohongshu.com/'}});
    if (resp.ok){
      const html=await resp.text();
      const tm=html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
      const im=html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      return j({note_id:nid,title:tm?tm[1].replace(' - 小红书','').trim():'',cover:im?im[1]:'',likes:0,author:'',avatar:''});
    }
  } catch {}
  return j({note_id:nid,title:'',cover:'',likes:0,author:'',avatar:'',error:'Cannot fetch note info, please fill manually'});
}

async function proxyImage(req) {
  const url=new URL(req.url), iu=(url.searchParams.get('url')||'').trim();
  if (!iu||!iu.startsWith('http')) return new Response('',{status:400});
  try {
    const r=await fetch(iu,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.xiaohongshu.com/'}});
    return new Response(await r.arrayBuffer(),{headers:{'Content-Type':r.headers.get('Content-Type')||'image/jpeg','Cache-Control':'public, max-age=86400','Access-Control-Allow-Origin':'*'}});
  } catch { return new Response('',{status:502}); }
}

async function upload(req) {
  const fd=await req.formData(), file=fd.get('file');
  if (!file) return e('No file');
  if (!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)) return e('Unsupported file type');
  if (file.size>5*1024*1024) return e('Image must be under 5MB');
  const ab=await file.arrayBuffer(), bytes=new Uint8Array(ab);
  let bin=''; for (let i=0;i<bytes.byteLength;i++) bin+=String.fromCharCode(bytes[i]);
  return j({url:`data:${file.type};base64,${btoa(bin)}`,filename:file.name});
}

// ===== ROUTER =====
export async function onRequest(context) {
  const {request, env} = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 只处理 /api/* 路径
  if (!path.startsWith('/api/')) {
    return context.next();
  }

  if (method === 'OPTIONS') {
    return new Response(null, {status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
  }

  try {
    let m;

    if (path==='/api/auth/login'&&method==='POST') return login(request,env);
    if (path==='/api/auth/register'&&method==='POST') return register(request,env);
    if (path==='/api/auth/xhs_login'&&method==='POST') return xhsLogin(request,env);
    if (path==='/api/auth/me'&&method==='GET') return me(request,env);
    if (path==='/api/auth/logout'&&method==='POST') return logout();

    if (path==='/api/upload'&&method==='POST') return upload(request);
    if (path==='/api/proxy_image'&&method==='GET') return proxyImage(request);
    if (path==='/api/fetch_note'&&method==='GET') return fetchNote(request);
    if (path==='/api/hot_notes'&&method==='GET') return getHotNotes(env);
    if (path==='/api/hot_notes/refresh'&&method==='POST') return refreshHotNotes(request,env);

    if (path==='/api/topics'&&method==='GET') return getTopics(request,env);
    if (path==='/api/topics'&&method==='POST') return createTopic(request,env);
    if (path==='/api/admin/topics'&&method==='GET') return adminGetTopics(request,env);
    if (path==='/api/submissions/export'&&method==='GET') return exportSubs(request,env);
    if (path==='/api/submissions'&&method==='GET') return getSubmissions(request,env);
    if (path==='/api/submissions'&&method==='POST') return createSub(request,env);
    if (path==='/api/admin/users'&&method==='GET') return adminGetUsers(request,env);
    if (path==='/api/users'&&method==='GET') return getUsers(request,env);

    m=path.match(/^\/api\/topics\/(\d+)$/);
    if (m){const id=parseInt(m[1]);if(method==='GET') return getTopic(request,env,id);if(method==='PUT') return updateTopic(request,env,id);if(method==='DELETE') return deleteTopic(request,env,id);}

    m=path.match(/^\/api\/topics\/(\d+)\/status$/);
    if (m&&method==='PUT') return updateTopicStatus(request,env,parseInt(m[1]));

    m=path.match(/^\/api\/topics\/(\d+)\/add_notes$/);
    if (m&&method==='POST') return addNotes(request,env,parseInt(m[1]));

    m=path.match(/^\/api\/topics\/(\d+)\/approved-submissions$/);
    if (m&&method==='GET') return getApprovedSubs(request,env,parseInt(m[1]));

    m=path.match(/^\/api\/admin\/topics\/(\d+)$/);
    if (m&&method==='DELETE') return deleteTopic(request,env,parseInt(m[1]));

    m=path.match(/^\/api\/admin\/users\/(\d+)\/verify$/);
    if (m&&method==='PUT') return verifyUser(request,env,parseInt(m[1]));

    m=path.match(/^\/api\/submissions\/(\d+)$/);
    if (m){const id=parseInt(m[1]);if(method==='PUT') return updateSub(request,env,id);if(method==='DELETE') return deleteSub(request,env,id);}

    m=path.match(/^\/api\/submissions\/(\d+)\/status$/);
    if (m&&method==='PUT') return updateSubStatus(request,env,parseInt(m[1]));

    m=path.match(/^\/api\/submissions\/(\d+)\/suggestion$/);
    if (m&&method==='PUT') return addSuggestion(request,env,parseInt(m[1]));

    return new Response('Not Found',{status:404});
  } catch(err) {
    console.error(err);
    return new Response(JSON.stringify({error:'Server Error',detail:err.message}),{status:500,headers:{'Content-Type':'application/json'}});
  }
}
