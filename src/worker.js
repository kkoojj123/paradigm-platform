// ===== Cloudflare Workers 主入口 =====
import { handleLogin, handleRegister, handleXhsLogin, handleMe, handleLogout } from './auth.js';
import {
  handleGetTopics, handleGetTopic, handleCreateTopic, handleUpdateTopic,
  handleUpdateTopicStatus, handleDeleteTopic, handleAdminGetTopics, handleAddNotes
} from './topics.js';
import {
  handleGetSubmissions, handleGetApprovedSubmissions, handleCreateSubmission,
  handleUpdateSubmission, handleUpdateSubmissionStatus, handleAddSuggestion,
  handleDeleteSubmission, handleExportSubmissions
} from './submissions.js';
import {
  handleAdminGetUsers, handleVerifyUser, handleGetUsers,
  handleGetHotNotes, handleRefreshHotNotes,
  handleFetchNote, handleProxyImage, handleUpload
} from './admin.js';
import { ASSETS } from 'cloudflare:workers';
import { CORS_HEADERS } from './utils.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // OPTIONS 预检
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ===== 静态页面（由 Cloudflare Assets 自动处理） =====
      if (path === '/' || path === '/index.html' || path === '/admin' || path === '/admin.html') {
        return env.ASSETS.fetch(request);
      }

      // ===== API 路由 =====

      // 认证
      if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
      if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);
      if (path === '/api/auth/xhs_login' && method === 'POST') return handleXhsLogin(request, env);
      if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
      if (path === '/api/auth/logout' && method === 'POST') return handleLogout();

      // 文件上传
      if (path === '/api/upload' && method === 'POST') return handleUpload(request, env);

      // 图片代理
      if (path === '/api/proxy_image' && method === 'GET') return handleProxyImage(request, env);

      // 笔记信息
      if (path === '/api/fetch_note' && method === 'GET') return handleFetchNote(request, env);

      // 热点笔记
      if (path === '/api/hot_notes' && method === 'GET') return handleGetHotNotes(request, env);
      if (path === '/api/hot_notes/refresh' && method === 'POST') return handleRefreshHotNotes(request, env);

      // 选题
      if (path === '/api/topics' && method === 'GET') return handleGetTopics(request, env);
      if (path === '/api/topics' && method === 'POST') return handleCreateTopic(request, env);
      if (path === '/api/admin/topics' && method === 'GET') return handleAdminGetTopics(request, env);

      // 投稿导出（必须在 /api/submissions/:id 之前匹配）
      if (path === '/api/submissions/export' && method === 'GET') return handleExportSubmissions(request, env);

      // 投稿列表
      if (path === '/api/submissions' && method === 'GET') return handleGetSubmissions(request, env);
      if (path === '/api/submissions' && method === 'POST') return handleCreateSubmission(request, env);

      // 用户管理
      if (path === '/api/admin/users' && method === 'GET') return handleAdminGetUsers(request, env);
      if (path === '/api/users' && method === 'GET') return handleGetUsers(request, env);

      // 动态路由匹配
      let m;

      // /api/topics/:id
      m = path.match(/^\/api\/topics\/(\d+)$/);
      if (m) {
        const id = parseInt(m[1]);
        if (method === 'GET') return handleGetTopic(request, env, id);
        if (method === 'PUT') return handleUpdateTopic(request, env, id);
        if (method === 'DELETE') return handleDeleteTopic(request, env, id);
      }

      // /api/topics/:id/status
      m = path.match(/^\/api\/topics\/(\d+)\/status$/);
      if (m && method === 'PUT') return handleUpdateTopicStatus(request, env, parseInt(m[1]));

      // /api/topics/:id/add_notes
      m = path.match(/^\/api\/topics\/(\d+)\/add_notes$/);
      if (m && method === 'POST') return handleAddNotes(request, env, parseInt(m[1]));

      // /api/topics/:id/approved-submissions
      m = path.match(/^\/api\/topics\/(\d+)\/approved-submissions$/);
      if (m && method === 'GET') return handleGetApprovedSubmissions(request, env, parseInt(m[1]));

      // /api/admin/topics/:id (DELETE)
      m = path.match(/^\/api\/admin\/topics\/(\d+)$/);
      if (m && method === 'DELETE') return handleDeleteTopic(request, env, parseInt(m[1]));

      // /api/admin/users/:id/verify
      m = path.match(/^\/api\/admin\/users\/(\d+)\/verify$/);
      if (m && method === 'PUT') return handleVerifyUser(request, env, parseInt(m[1]));

      // /api/submissions/:id
      m = path.match(/^\/api\/submissions\/(\d+)$/);
      if (m) {
        const id = parseInt(m[1]);
        if (method === 'PUT') return handleUpdateSubmission(request, env, id);
        if (method === 'DELETE') return handleDeleteSubmission(request, env, id);
      }

      // /api/submissions/:id/status
      m = path.match(/^\/api\/submissions\/(\d+)\/status$/);
      if (m && method === 'PUT') return handleUpdateSubmissionStatus(request, env, parseInt(m[1]));

      // /api/submissions/:id/suggestion
      m = path.match(/^\/api\/submissions\/(\d+)\/suggestion$/);
      if (m && method === 'PUT') return handleAddSuggestion(request, env, parseInt(m[1]));

      return new Response('Not Found', { status: 404 });

    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ error: '服务器内部错误', detail: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

// 从 ASSETS binding 提供静态页面
async function serveHtml(env, filename) {
  try {
    const asset = await env.ASSETS.fetch(new Request(`https://placeholder/${filename}`));
    if (asset.ok) return asset;
  } catch {}
  return new Response('<!DOCTYPE html><html><body>Page not found</body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
