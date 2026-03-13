const PASSWORD = process.env.APP_PASSWORD || 'pomodoro2026';

export default async function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const pass = atob(auth.slice(6)).split(':').slice(1).join(':');
      if (pass === PASSWORD) return;
    } catch(e) {}
  }

  return new Response('Login required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Pomodoro"' },
  });
}

export const config = { matcher: '/((?!_next).*)' };
