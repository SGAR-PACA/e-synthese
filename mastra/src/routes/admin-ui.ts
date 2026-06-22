import { registerApiRoute } from '@mastra/core/server';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

function findPublicDir(): string {
  if (process.env.PUBLIC_DIR && existsSync(join(process.env.PUBLIC_DIR, 'admin'))) {
    return process.env.PUBLIC_DIR;
  }
  const candidates = [
    join(process.cwd(), 'public'),
    join(process.cwd(), '..', '..', '..', 'public'),
    join(process.cwd(), '..', '..', 'public'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'admin'))) {
      return candidate;
    }
  }
  return join(process.cwd(), 'public');
}

const PUBLIC_DIR = findPublicDir();

function serveStatic(filePath: string) {
  return async () => {
    const fullPath = join(PUBLIC_DIR, filePath);
    if (!existsSync(fullPath)) {
      return new Response('Not Found', { status: 404 });
    }
    const content = readFileSync(fullPath, 'utf8');
    const ext = extname(fullPath);
    return new Response(content, {
      headers: { 'Content-Type': MIME_TYPES[ext] || 'text/plain' },
    });
  };
}

export const adminUiRoute = [
  registerApiRoute('/', { method: 'GET', handler: async () => new Response(null, { status: 302, headers: { Location: '/admin/' } }) }),
  registerApiRoute('/admin', { method: 'GET', handler: async () => new Response(null, { status: 302, headers: { Location: '/admin/' } }) }),
  registerApiRoute('/admin/', { method: 'GET', handler: serveStatic('admin/index.html') }),
  registerApiRoute('/admin/login', { method: 'GET', handler: serveStatic('admin/login.html') }),
  registerApiRoute('/admin/register', { method: 'GET', handler: serveStatic('admin/register.html') }),
  registerApiRoute('/admin/forgot-password', { method: 'GET', handler: serveStatic('admin/forgot-password.html') }),
  registerApiRoute('/admin/reset-password', { method: 'GET', handler: serveStatic('admin/reset-password.html') }),
  registerApiRoute('/admin/settings', { method: 'GET', handler: serveStatic('admin/config.html') }),
  registerApiRoute('/admin/collections', { method: 'GET', handler: serveStatic('admin/collections.html') }),
  registerApiRoute('/admin/documents', { method: 'GET', handler: serveStatic('admin/documents.html') }),
  registerApiRoute('/admin/test', { method: 'GET', handler: serveStatic('admin/test.html') }),
  registerApiRoute('/admin/users-page', { method: 'GET', handler: serveStatic('admin/users.html') }),
  registerApiRoute('/admin/account', { method: 'GET', handler: serveStatic('admin/me.html') }),
  registerApiRoute('/admin/audit-page', { method: 'GET', handler: serveStatic('admin/audit.html') }),
  registerApiRoute('/admin/eval', { method: 'GET', handler: serveStatic('admin/eval.html') }),
  registerApiRoute('/admin/ratings-page', { method: 'GET', handler: serveStatic('admin/ratings.html') }),
  registerApiRoute('/admin/style.css', { method: 'GET', handler: serveStatic('admin/style.css') }),
  registerApiRoute('/admin/app.js', { method: 'GET', handler: serveStatic('admin/app.js') }),
  registerApiRoute('/admin/pico.min.css', { method: 'GET', handler: serveStatic('admin/pico.min.css') }),
];
