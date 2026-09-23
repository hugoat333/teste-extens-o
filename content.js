// Injetado pelo popup via chrome.scripting.executeScript.
// O valor da última expressão (a IIFE) é devolvido ao popup como resultado.
(() => {
  // Protocolo opcional: snippets do Google e textos de fórum costumam trazer o link sem "https://".
  const PATTERNS = [
    {
      platform: 'WhatsApp',
      regex: /((?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?[A-Za-z0-9]{20,})/gi
    },
    {
      platform: 'Telegram',
      // Cobre t.me/usuario, t.me/+hash e t.me/joinchat/hash
      regex: /((?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:joinchat\/[A-Za-z0-9_-]{5,}|\+[A-Za-z0-9_-]{5,}|[A-Za-z0-9_]{5,}))/gi
    },
    {
      platform: 'Discord',
      regex: /((?:https?:\/\/)?(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[A-Za-z0-9-]{2,})/gi
    },
    {
      platform: 'Facebook',
      regex: /((?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/groups\/[A-Za-z0-9._-]+)/gi
    }
  ];

  // Caminhos do Telegram que não são grupos/canais.
  const TELEGRAM_BLOCKLIST = new Set(['share', 'addstickers', 'addemoji', 'addtheme', 'proxy', 'socks', 'setlanguage', 'login', 'iv']);
  // Caminhos do Facebook que não são um grupo específico.
  const FACEBOOK_BLOCKLIST = new Set(['feed', 'discover', 'create', 'joins', 'search', 'notifications', 'category']);

  const MAX_TITLE = 140;
  const results = new Map();

  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const truncate = (text) => (text.length > MAX_TITLE ? text.slice(0, MAX_TITLE - 1) + '…' : text);

  // Padroniza para evitar duplicatas (http vs https, www, barra final, query string, caixa do host).
  function normalize(rawUrl, platform) {
    let url = rawUrl.replace(/[).,;:!?'"\]}>]+$/, '');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      u.protocol = 'https:';
      u.hash = '';
      u.search = '';
      let host = u.hostname.toLowerCase();
      if (platform === 'Facebook') host = 'www.facebook.com';
      if (platform === 'Telegram' && host === 'telegram.me') host = 't.me';
      if (platform === 'Discord' && host !== 'discord.gg') {
        // discord.com/invite/X e discordapp.com/invite/X → discord.gg/X
        const code = u.pathname.split('/').filter(Boolean)[1];
        return code ? `https://discord.gg/${code}` : null;
      }
      const path = u.pathname.replace(/\/+$/, '');
      return `https://${host}${path}`;
    } catch (_) {
      return null;
    }
  }

  function isValid(url, platform) {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (platform === 'Telegram') {
      return parts.length > 0 && !TELEGRAM_BLOCKLIST.has(parts[0].toLowerCase());
    }
    if (platform === 'Facebook') {
      return parts.length >= 2 && !FACEBOOK_BLOCKLIST.has(parts[1].toLowerCase());
    }
    return parts.length > 0;
  }

  // Busca um título útil: texto do link → atributos → heading/contexto mais próximo.
  function titleFor(el, url) {
    if (!el) return '';
    const candidates = [];
    if (el.tagName === 'A') {
      candidates.push(el.getAttribute('title'), el.getAttribute('aria-label'), el.innerText);
      const img = el.querySelector('img[alt]');
      if (img) candidates.push(img.alt);
    }
    const container = el.closest('article, li, [role="listitem"], .g, .MjjYud, tr, .post, .message');
    if (container) {
      const heading = container.querySelector('h1, h2, h3, h4, [role="heading"]');
      if (heading) candidates.push(heading.innerText);
    }
    for (const c of candidates) {
      const t = clean(c);
      // Ignora títulos que são só o próprio link.
      if (t && !/^(https?:\/\/)?(chat\.whatsapp|t\.me|telegram\.me|discord|(www\.)?facebook)/i.test(t)) {
        return truncate(t);
      }
    }
    // Último recurso: trecho de texto ao redor do link.
    const context = clean(
      (el.innerText || '').replace(/(https?:\/\/)?(chat\.whatsapp\.com|t\.me|telegram\.me|discord\.gg|discord(app)?\.com|(www\.|m\.)?facebook\.com)\/\S*/gi, ' ')
    ).replace(/[\s:,-]+$/, '');
    return truncate(context);
  }

  function add(rawUrl, platform, el) {
    const url = normalize(rawUrl, platform);
    if (!url || !isValid(url, platform)) return;
    const title = titleFor(el, url);
    const existing = results.get(url);
    if (!existing) {
      results.set(url, { url, platform, title });
    } else if (!existing.title && title) {
      existing.title = title;
    }
  }

  function matchAll(text, el) {
    if (!text) return;
    for (const { platform, regex } of PATTERNS) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(text)) !== null) add(m[1], platform, el);
    }
  }

  // Resultados do Google às vezes vêm como /url?q=<destino>; outros sites usam redirecionadores parecidos.
  function unwrapRedirect(href) {
    try {
      const u = new URL(href, location.href);
      for (const key of ['q', 'url', 'u', 'link', 'target', 'redirect']) {
        const v = u.searchParams.get(key);
        if (v && /^https?:\/\//i.test(v)) return v;
      }
    } catch (_) { /* ignora */ }
    return null;
  }

  // 1) Links (<a href>) e atributos comuns de links em SPA.
  document.querySelectorAll('a[href], [data-href], [data-url]').forEach((el) => {
    const values = [el.getAttribute('href'), el.getAttribute('data-href'), el.getAttribute('data-url')];
    for (const v of values) {
      if (!v) continue;
      let decoded = v;
      try { decoded = decodeURIComponent(v); } catch (_) { /* mantém original */ }
      matchAll(decoded, el);
      const target = unwrapRedirect(v);
      if (target) matchAll(target, el);
    }
  });

  // 2) Texto visível (links colados em posts/comentários sem <a>).
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
      return /whatsapp|t\.me|telegram|discord|facebook/i.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  let node;
  while ((node = walker.nextNode())) matchAll(node.nodeValue, node.parentElement);

  // 3) Campos de formulário (alguns sites exibem o convite num input para copiar).
  document.querySelectorAll('input[value], textarea').forEach((el) => matchAll(el.value, el));

  return {
    source: location.href,
    pageTitle: document.title,
    items: Array.from(results.values())
  };
})();
