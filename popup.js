const STORAGE_KEY = 'groups';
const SETTINGS_KEY = 'settings';

const $ = (sel) => document.querySelector(sel);
const els = {
  count: $('#count'),
  status: $('#status'),
  search: $('#search'),
  results: $('#results'),
  stats: $('#stats'),
  scanBtn: $('#scanBtn'),
  copyAllBtn: $('#copyAllBtn'),
  exportBtn: $('#exportBtn'),
  clearBtn: $('#clearBtn'),
  accumulate: $('#accumulate'),
  template: $('#itemTemplate')
};

let groups = [];            // lista completa (persistida)
let platformFilter = null;  // filtro por chip de plataforma

// ---------- Estado / storage ----------

async function loadState() {
  const data = await chrome.storage.local.get([STORAGE_KEY, SETTINGS_KEY]);
  groups = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  const settings = data[SETTINGS_KEY] || {};
  els.accumulate.checked = settings.accumulate !== false;
}

function saveGroups() {
  return chrome.storage.local.set({ [STORAGE_KEY]: groups });
}

function saveSettings() {
  return chrome.storage.local.set({ [SETTINGS_KEY]: { accumulate: els.accumulate.checked } });
}

// Mescla sem duplicar (chave = URL normalizada pelo content.js). Retorna quantos são novos.
function mergeGroups(incoming, source) {
  const byUrl = new Map(groups.map((g) => [g.url, g]));
  const now = new Date().toISOString();
  let added = 0;
  for (const item of incoming) {
    const existing = byUrl.get(item.url);
    if (existing) {
      if (!existing.title && item.title) existing.title = item.title;
      continue;
    }
    byUrl.set(item.url, { ...item, source, foundAt: now });
    added++;
  }
  groups = Array.from(byUrl.values());
  return added;
}

// ---------- UI helpers ----------

function setStatus(text, type = '') {
  els.status.textContent = text;
  els.status.className = 'status' + (type ? ' ' + type : '');
  els.status.title = text;
}

function flashButton(btn, text = 'Copiado!', ms = 2000) {
  if (btn._flashTimer) clearTimeout(btn._flashTimer);
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  btn.classList.add('copied');
  btn._flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('copied');
    btn._flashTimer = null;
  }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback para contextos em que a Clipboard API é bloqueada.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function getFiltered() {
  const q = els.search.value.trim().toLowerCase();
  return groups.filter((g) => {
    if (platformFilter && g.platform !== platformFilter) return false;
    if (!q) return true;
    return (
      g.platform.toLowerCase().includes(q) ||
      (g.title || '').toLowerCase().includes(q) ||
      g.url.toLowerCase().includes(q)
    );
  });
}

// ---------- Render ----------

function renderStats() {
  els.count.textContent = groups.length;
  for (const chip of els.stats.querySelectorAll('.stat')) {
    const p = chip.dataset.platform;
    chip.querySelector('b').textContent = groups.filter((g) => g.platform === p).length;
    chip.classList.toggle('active', platformFilter === p);
  }
}

function renderEmpty(filtered) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  if (groups.length === 0) {
    div.innerHTML = '<strong>Nenhum grupo ainda</strong>Abra uma página (busca do Google, fórum, linktree...) e clique em "Escanear Página".';
  } else if (filtered.length === 0) {
    div.innerHTML = '<strong>Nada encontrado</strong>Nenhum grupo corresponde ao filtro atual.';
  }
  els.results.appendChild(div);
}

function render() {
  renderStats();
  const filtered = getFiltered();
  els.results.textContent = '';

  const hasItems = filtered.length > 0;
  els.copyAllBtn.disabled = !hasItems;
  els.exportBtn.disabled = !hasItems;

  if (!hasItems) {
    renderEmpty(filtered);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const g of filtered) {
    const node = els.template.content.firstElementChild.cloneNode(true);

    const badge = node.querySelector('.badge');
    badge.textContent = g.platform;
    badge.classList.add(g.platform);

    const title = node.querySelector('.title');
    if (g.title) {
      title.textContent = g.title;
      title.title = g.title;
    } else {
      title.textContent = 'Sem título';
      title.classList.add('empty');
    }

    const link = node.querySelector('.url');
    link.href = g.url;
    link.textContent = g.url;
    link.title = g.source ? `Encontrado em: ${g.source}` : g.url;

    const btn = node.querySelector('.copy-btn');
    btn.addEventListener('click', async () => {
      if (await copyText(g.url)) flashButton(btn);
    });

    frag.appendChild(node);
  }
  els.results.appendChild(frag);
}

// ---------- Scan ----------

async function scanPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus('Nenhuma aba ativa encontrada', 'error');
    return;
  }
  if (!/^https?:|^file:/i.test(tab.url || '')) {
    setStatus('Esta página não pode ser escaneada (página interna do navegador)', 'error');
    return;
  }

  els.scanBtn.disabled = true;
  els.scanBtn.textContent = 'Escaneando...';
  setStatus('Varrendo a página...');

  try {
    // allFrames: pega também links dentro de iframes (embeds, widgets de fórum).
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js']
    });

    const found = [];
    for (const inj of injections) {
      if (inj && inj.result && Array.isArray(inj.result.items)) found.push(...inj.result.items);
    }

    if (!els.accumulate.checked) groups = [];
    const added = mergeGroups(found, tab.url);
    await saveGroups();
    render();

    const unique = new Set(found.map((f) => f.url)).size;
    setStatus(
      unique === 0
        ? 'Nenhum link de grupo nesta página'
        : `${unique} encontrado(s) nesta página · ${added} novo(s)`,
      unique === 0 ? '' : 'ok'
    );
  } catch (err) {
    console.error(err);
    setStatus('Erro ao escanear: ' + (err.message || err), 'error');
  } finally {
    els.scanBtn.disabled = false;
    els.scanBtn.textContent = 'Escanear Página';
  }
}

// ---------- CSV ----------

function csvEscape(value) {
  const s = String(value ?? '');
  return /[";\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  // Separador ";" + BOM UTF-8: abre corretamente no Excel em pt-BR (acentos e colunas).
  const header = ['Plataforma', 'Titulo', 'URL', 'Pagina de Origem', 'Encontrado em'];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push([r.platform, r.title, r.url, r.source, r.foundAt].map(csvEscape).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

function exportCSV() {
  const rows = getFiltered();
  if (!rows.length) return;

  const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  const a = document.createElement('a');
  a.href = url;
  a.download = `grupos-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  flashButton(els.exportBtn, 'Exportado!');
}

// ---------- Eventos ----------

els.scanBtn.addEventListener('click', scanPage);

els.copyAllBtn.addEventListener('click', async () => {
  const rows = getFiltered();
  if (!rows.length) return;
  if (await copyText(rows.map((g) => g.url).join('\n'))) flashButton(els.copyAllBtn);
});

els.exportBtn.addEventListener('click', exportCSV);

els.search.addEventListener('input', render);

els.stats.addEventListener('click', (e) => {
  const chip = e.target.closest('.stat');
  if (!chip) return;
  const p = chip.dataset.platform;
  platformFilter = platformFilter === p ? null : p;
  render();
});

els.accumulate.addEventListener('change', saveSettings);

els.clearBtn.addEventListener('click', async () => {
  if (!groups.length) return;
  if (!confirm(`Remover os ${groups.length} grupos salvos?`)) return;
  groups = [];
  platformFilter = null;
  await saveGroups();
  render();
  setStatus('Lista limpa');
});

// ---------- Init ----------

(async () => {
  await loadState();
  render();
  if (groups.length) setStatus(`${groups.length} grupo(s) salvos · escaneie para adicionar mais`);
})();
