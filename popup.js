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
  autoScrollBtn: $('#autoScrollBtn'),
  scrollDuration: $('#scrollDuration'),
  scrollHint: $('#scrollHint'),
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

let autoScrollRunning = false;
let stopRequested = false;

async function getScannableTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus('Nenhuma aba ativa encontrada', 'error');
    return null;
  }
  if (!/^https?:|^file:/i.test(tab.url || '')) {
    setStatus('Esta página não pode ser escaneada (página interna do navegador)', 'error');
    return null;
  }
  return tab;
}

// Injeta o content.js em todos os frames e junta os resultados.
async function collectFromTab(tabId) {
  // allFrames: pega também links dentro de iframes (embeds, widgets de fórum).
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js']
  });
  const found = [];
  for (const inj of injections) {
    if (inj && inj.result && Array.isArray(inj.result.items)) found.push(...inj.result.items);
  }
  return found;
}

async function scanPage() {
  const tab = await getScannableTab();
  if (!tab) return;

  setBusy(true);
  els.scanBtn.textContent = 'Escaneando...';
  setStatus('Varrendo a página...');

  try {
    const found = await collectFromTab(tab.id);
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
    setBusy(false);
  }
}

// Executada DENTRO da página: rola até o fim e espera novo conteúdo carregar.
// Retorna { grew } indicando se a página cresceu (carregou mais itens).
async function scrollStepInPage(waitMs) {
  // Alguns sites (Discord, parte do Facebook) rolam um container interno em vez da janela.
  function findScroller() {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 50) return root;
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('div, main, section, ul')) {
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best || root;
  }

  // Assinatura do conteúdo: detecta carga nova mesmo quando o site remove itens antigos
  // e a altura total não muda (listas virtualizadas).
  const signature = (el) => `${el.scrollHeight}|${(el.lastElementChild || el).textContent.length}|${document.body.textContent.length}`;

  const scroller = findScroller();
  const before = signature(scroller);
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
  window.scrollTo(0, document.documentElement.scrollHeight);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (signature(scroller) !== before) {
      // Dá um tempo extra para o conteúdo novo terminar de renderizar.
      await new Promise((r) => setTimeout(r, 400));
      return { grew: true };
    }
  }
  return { grew: false };
}

async function autoScrollAndScan() {
  if (autoScrollRunning) {
    stopRequested = true;
    els.autoScrollBtn.textContent = 'Parando...';
    return;
  }

  const tab = await getScannableTab();
  if (!tab) return;

  const maxSeconds = Number(els.scrollDuration.value) || 60;
  const deadline = Date.now() + maxSeconds * 1000;
  const MAX_IDLE_STEPS = 4; // para se a página não carregar nada novo por 4 tentativas seguidas

  autoScrollRunning = true;
  stopRequested = false;
  setBusy(true);
  els.autoScrollBtn.disabled = false;
  els.autoScrollBtn.textContent = 'Parar';
  els.autoScrollBtn.classList.add('danger');
  els.scrollHint.hidden = false;

  if (!els.accumulate.checked) groups = [];
  const seenThisRun = new Set();
  let totalAdded = 0;
  let idleSteps = 0;
  let step = 0;
  let reason = 'tempo esgotado';

  try {
    while (Date.now() < deadline) {
      if (stopRequested) { reason = 'interrompido'; break; }

      // Escaneia a cada passo: sites como o Facebook removem posts antigos do DOM ao rolar.
      const found = await collectFromTab(tab.id);
      found.forEach((f) => seenThisRun.add(f.url));
      const added = mergeGroups(found, tab.url);
      totalAdded += added;
      if (added) {
        await saveGroups();
        render();
      }

      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setStatus(`Rolando... ${seenThisRun.size} achado(s) · ${totalAdded} novo(s) · ${remaining}s`, 'ok');

      if (stopRequested) { reason = 'interrompido'; break; }

      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollStepInPage,
        args: [2500]
      });
      step++;

      if ((res && res.result && res.result.grew) || added > 0) {
        idleSteps = 0;
      } else if (++idleSteps >= MAX_IDLE_STEPS) {
        reason = 'fim da página';
        break;
      }
    }

    // Varredura final para pegar o que carregou no último passo.
    const found = await collectFromTab(tab.id);
    found.forEach((f) => seenThisRun.add(f.url));
    totalAdded += mergeGroups(found, tab.url);
    await saveGroups();
    render();

    setStatus(`Concluído (${reason}) · ${step} rolagens · ${seenThisRun.size} achado(s) · ${totalAdded} novo(s)`, 'ok');
  } catch (err) {
    console.error(err);
    await saveGroups();
    render();
    setStatus('Erro na rolagem: ' + (err.message || err), 'error');
  } finally {
    autoScrollRunning = false;
    stopRequested = false;
    els.autoScrollBtn.textContent = 'Rolar e Escanear';
    els.autoScrollBtn.classList.remove('danger');
    els.scrollHint.hidden = true;
    setBusy(false);
  }
}

function setBusy(busy) {
  els.scanBtn.disabled = busy;
  els.autoScrollBtn.disabled = busy && !autoScrollRunning;
  els.scrollDuration.disabled = busy;
  els.clearBtn.disabled = busy;
  if (!busy) els.scanBtn.textContent = 'Escanear Página';
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
els.autoScrollBtn.addEventListener('click', autoScrollAndScan);

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
