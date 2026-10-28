(function () {
  'use strict';
  const BASE = document.querySelector('meta[name=admin-base]').content;
  const $app = document.getElementById('app');
  let ME = null, CUR = '$', CATS = [], SUPPLIERS = [];

  // ---------- tiny DOM helpers (text only: no innerHTML anywhere) ----------
  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'multiple']);
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(9)) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return e;
  }
  const money = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return CUR + v.toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); };
  const fdt = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const fd = (t) => (t ? new Date(t).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
  const can = (p) => ME && ME.perms.includes(p);
  const label = (s) => (ME.labels[s] || s).replace(/^./, (c) => c.toUpperCase());
  const pill = (s) => h('span', { class: 'pill s-' + s }, label(s));
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  async function api(method, path, body) {
    const o = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { o.headers['Content-Type'] = 'application/json'; o.headers['X-CSRF-Token'] = ME ? ME.csrf : ''; o.body = JSON.stringify(body || {}); }
    const r = await fetch(BASE + '/api' + path, o);
    let j = null; try { j = await r.json(); } catch { /* empty */ }
    if (r.status === 401 && ME) { location.reload(); throw new Error('Signed out'); }
    if (!r.ok) { const e = new Error((j && j.error) || 'Request failed'); e.status = r.status; e.fields = j && j.fields; e.data = j; throw e; }
    return j;
  }
  let toastT;
  function toast(msg, bad) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
    document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3800);
  }
  const fail = (e) => { if (e && e.message !== 'Signed out') toast(e.message || 'Something went wrong', true); };

  // ---------- modal / confirm ----------
  const stack = [];
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length) stack[stack.length - 1](); });
  function modal(title, body, opts = {}) {
    const back = h('div', { class: 'overlay' });
    const close = () => { back.remove(); const i = stack.indexOf(close); if (i >= 0) stack.splice(i, 1); if (opts.onClose) opts.onClose(); };
    const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'mh' }, h('h2', {}, title), h('button', { class: 'x', 'aria-label': 'Close', onclick: close }, '×')), h('div', { class: 'mb' }, body));
    back.append(box); back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.body.append(back); stack.push(close);
    return { close, box };
  }
  function confirmBox(msg, yes = 'Confirm', danger = false) {
    return new Promise((res) => {
      let done = false; const fin = (v) => { if (!done) { done = true; m.close(); res(v); } };
      const m = modal('Please confirm', h('div', {}, h('p', {}, msg), h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => fin(false) }, 'Cancel'), h('button', { class: 'btn ' + (danger ? 'bad' : 'pri'), onclick: () => fin(true) }, yes))), { onClose: () => fin(false) });
    });
  }

  // ---------- forms ----------
  function form(specs, vals = {}) {
    const inputs = {}, errs = {};
    const rows = specs.filter((f) => !f.skip).map((f) => {
      const v = vals[f.k];
      let inp;
      if (f.type === 'textarea') inp = h('textarea', { rows: f.rows || 3, value: v == null ? '' : v });
      else if (f.type === 'select') inp = h('select', {}, ...f.opts.map((o) => h('option', { value: o[0], selected: String(o[0]) === String(v == null ? '' : v) }, o[1])));
      else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', checked: !!v });
      else inp = h('input', { type: f.type || 'text', value: v == null ? '' : v, step: f.step, min: f.min, inputmode: f.mode, autocomplete: f.type === 'password' ? 'new-password' : 'off', maxlength: f.max });
      inputs[f.k] = inp; errs[f.k] = h('div', { class: 'err' });
      return h('label', { class: 'fld' + (f.type === 'checkbox' ? ' chk' : '') + (f.wide ? ' wide' : '') }, h('span', {}, f.label, f.req ? ' *' : ''), inp, f.hint && h('small', {}, f.hint), errs[f.k]);
    });
    return {
      el: h('div', { class: 'grid2' }, ...rows), inputs,
      collect() { const o = {}; for (const f of specs) if (!f.skip) o[f.k] = f.type === 'checkbox' ? inputs[f.k].checked : inputs[f.k].value; return o; },
      errors(fields) { for (const k in errs) errs[k].textContent = (fields && fields[k]) || ''; },
    };
  }
  async function run(btn, fn, f) {
    btn.disabled = true;
    try { await fn(); return true; } catch (e) { if (f && e.fields) f.errors(e.fields); fail(e); return false; } finally { btn.disabled = false; }
  }
  function recordModal(title, specs, vals, save, done) {
    const f = form(specs, vals), btn = h('button', { class: 'btn pri' }, 'Save');
    const m = modal(title, h('div', {}, f.el, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), btn)));
    btn.addEventListener('click', async () => { f.errors(null); if (await run(btn, async () => { await save(f.collect()); }, f)) { m.close(); toast('Saved'); if (done) done(); } });
  }
  function table(cols, rows, empty) {
    if (!rows.length) return h('div', { class: 'empty' }, empty || 'Nothing here yet');
    return h('div', { class: 'tw' }, h('table', { class: 'cards' }, h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', {}, c.h)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...cols.map((c) => h('td', { 'data-label': c.h }, c.c(r))))))));
  }
  const stat = (t, v, cls) => h('div', { class: 'stat ' + (cls || '') }, h('small', {}, t), h('b', {}, v));
  const head = (t, lead, right) => h('div', { class: 'row sp' }, h('div', {}, h('h1', { class: 'pt' }, t), lead && h('p', { class: 'lead' }, lead)), right);
  const imgUrl = (id) => BASE + '/api/media/' + id;

  function readImage(file) {   // downscale big phone photos so they upload quickly and stay under the server limit
    return new Promise((resolve, reject) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Choose a JPEG, PNG or WebP image'));
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.84));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }

  // =====================================================================
  // OVERVIEW
  // =====================================================================
  async function viewOverview(v) {
    const o = await api('GET', '/overview');
    v.append(head('Overview', 'What needs your attention today.'));
    const st = h('div', { class: 'stats' });
    if (o.requests) st.append(stat('New WhatsApp requests', o.requests.new_request, o.requests.new_request ? 'alert' : ''), stat('Awaiting payment', o.requests.awaiting_payment), stat('To fulfil / ship', o.to_ship));
    if (o.low_stock !== undefined) st.append(stat('Low-stock items', o.low_stock, o.low_stock ? 'alert' : 'good'));
    if (o.products) st.append(stat('Products live', o.products.published + ' / ' + o.products.total));
    v.append(st);
    if (o.finance) v.append(financeCard());
    if (o.recent) v.append(h('div', { class: 'card' }, h('h3', {}, 'Latest requests & orders'), table([
      { h: 'Order', c: (r) => h('button', { class: 'btn sm', onclick: () => openOrder(r.id) }, r.code) }, { h: 'Customer', c: (r) => r.name },
      { h: 'Total', c: (r) => money(r.total) }, { h: 'Status', c: (r) => pill(r.status) }, { h: 'Date', c: (r) => fdt(r.created_at) }], o.recent, 'No requests yet')));
  }
  function financeCard() {
    const card = h('div', { class: 'card' });
    const today = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const from = h('input', { type: 'date', value: start }), to = h('input', { type: 'date', value: today });
    const body = h('div', {});
    async function load() {
      body.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
      try {
        const f = await api('GET', '/finance?' + qs({ from: from.value, to: to.value }));
        const bars = h('div', { class: 'chart' }), map = Object.fromEntries(f.daily.map((d) => [d.d, d]));
        const days = []; for (let t = Date.parse(from.value + 'T00:00:00Z'); t <= Date.parse(to.value + 'T00:00:00Z') && days.length < 31; t += 864e5) days.push(new Date(t).toISOString().slice(0, 10));
        const max = Math.max(1, ...days.map((d) => (map[d] ? map[d].sales : 0)));
        for (const d of days) { const b = h('div', { 'data-tip': d + ': ' + money(map[d] ? map[d].sales : 0) }); b.style.height = Math.max(2, ((map[d] ? map[d].sales : 0) / max) * 100) + '%'; bars.append(b); }
        body.replaceChildren(
          h('div', { class: 'stats' }, stat('Net sales (confirmed orders)', money(f.net_sales)), stat('Supplier cost', money(f.cogs)), stat('Order expenses', money(f.order_expenses)), stat('General expenses', money(f.general_expenses)),
            stat('Refunds', money(f.refunds)), stat('Net profit', money(f.net_profit), f.net_profit >= 0 ? 'good' : 'alert'), stat('Margin', f.margin == null ? '—' : f.margin + '%')),
          h('div', { class: 'note info' }, `Profit counts only confirmed orders where every item has a recorded supplier cost (${f.complete_orders} order${f.complete_orders === 1 ? '' : 's'}). ` +
            (f.incomplete_orders ? `${f.incomplete_orders} confirmed order(s) worth ${money(f.incomplete_sales)} are excluded until their costs are recorded. ` : '') +
            `Sales are counted when you confirm an order, not when a customer opens WhatsApp. Not yet confirmed: ${f.pipeline_orders} request(s), ${money(f.pipeline_value)}.`), bars,
          h('div', { class: 'sm' }, 'Daily confirmed sales'));
      } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, e.message)); }
    }
    card.append(h('div', { class: 'row sp' }, h('h3', {}, 'Sales & profit'), h('div', { class: 'row bar' }, from, to, h('button', { class: 'btn sm', onclick: load }, 'Apply'),
      can('finance:w') && h('button', { class: 'btn sm', onclick: () => expensesModal(load) }, 'Expenses'))), body);
    load(); return card;
  }
  async function expensesModal(after) {
    const wrap = h('div', {});
    async function draw() {
      const list = await api('GET', '/expenses?' + qs({ from: new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10) }));
      wrap.replaceChildren(table([{ h: 'Date', c: (e) => fd(e.ts) }, { h: 'Type', c: (e) => e.kind.replace('_', ' ') }, { h: 'Order', c: (e) => e.order_code || 'General' },
        { h: 'Amount', c: (e) => money(e.amount) }, { h: 'Note', c: (e) => e.note || '' },
        { h: '', c: (e) => h('button', { class: 'btn sm bad', onclick: async () => { if (await confirmBox('Delete this expense?', 'Delete', true)) { await api('DELETE', '/expenses/' + e.id); draw(); after(); } } }, 'Delete') }], list, 'No expenses recorded in the last 90 days'));
    }
    const f = form([{ k: 'kind', label: 'Type', type: 'select', opts: [['advertising', 'Advertising'], ['shipping_cost', 'Shipping paid'], ['packaging', 'Packaging'], ['payment_fee', 'Payment fees'], ['other', 'Other']] },
      { k: 'amount', label: 'Amount', type: 'number', step: '0.01', req: true }, { k: 'date', label: 'Date', type: 'date', hint: 'Leave empty for today' }, { k: 'note', label: 'Note', max: 200 }]);
    const btn = h('button', { class: 'btn pri' }, 'Add general expense');
    btn.addEventListener('click', () => run(btn, async () => { f.errors(null); await api('POST', '/expenses', f.collect()); toast('Expense recorded'); draw(); after(); }, f));
    modal('Business expenses', h('div', {}, h('p', { class: 'sm' }, 'General expenses (ads, tools, packaging stock). Costs for a single order are added inside that order.'), f.el, h('div', { class: 'actions' }, btn), wrap), { wide: true });
    draw();
  }

  // =====================================================================
  // PRODUCTS
  // =====================================================================
  async function viewProducts(v) {
    const q = h('input', { placeholder: 'Search name, SKU, brand', type: 'search' });
    const cat = h('select', {}, h('option', { value: '' }, 'All categories'), ...CATS.map((c) => h('option', { value: c.id }, c.name)));
    const stt = h('select', {}, h('option', { value: '' }, 'All statuses'), h('option', { value: 'published' }, 'Published'), h('option', { value: 'draft' }, 'Draft'));
    const out = h('div', { class: 'card' });
    v.append(head('Products', 'Add, price, publish and manage stock.', can('products:w') && h('button', { class: 'btn pri', onclick: () => editProduct(null, load) }, '+ Add product')),
      h('div', { class: 'row bar', style: { marginBottom: '14px' } }, q, cat, stt), out);
    let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 250); }); cat.addEventListener('change', load); stt.addEventListener('change', load);
    async function load() {
      const rows = await api('GET', '/products?' + qs({ q: q.value.trim(), category_id: cat.value, status: stt.value, limit: 200 }));
      out.replaceChildren(table([
        { h: '', c: (p) => (p.cover ? h('img', { class: 'thumb', src: imgUrl(p.cover), alt: '' }) : h('div', { class: 'thumb' })) },
        { h: 'Product', c: (p) => h('div', {}, h('b', {}, p.name), h('span', { class: 'sub' }, [p.sku, p.brand].filter(Boolean).join(' · '))) },
        { h: 'Category', c: (p) => p.category_name || '—' },
        { h: 'Price', c: (p) => h('div', {}, money(p.price), p.compare_price ? h('span', { class: 'sub' }, 'was ' + money(p.compare_price)) : null) },
        ...(can('finance:r') ? [{ h: 'Cost', c: (p) => (p.cost_price == null ? h('span', { class: 'pill warn' }, 'not set') : money(p.cost_price)) }] : []),
        { h: 'Stock', c: (p) => h('span', { class: 'pill ' + (p.stock_total <= p.low_stock ? 'warn' : '') }, p.stock_total + (p.variant_count ? ' (' + p.variant_count + ' variants)' : '')) },
        { h: 'Status', c: (p) => h('span', { class: 'pill ' + (p.published ? 'ok' : '') }, p.published ? 'Published' : 'Draft') },
        { h: '', c: (p) => (can('products:w') ? h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => editProduct(p.id, load) }, 'Edit'),
          h('button', { class: 'btn sm', onclick: async () => { try { await api('POST', '/products/' + p.id + '/publish', { published: !p.published }); toast(p.published ? 'Unpublished' : 'Published'); load(); } catch (e) { fail(e); } } }, p.published ? 'Unpublish' : 'Publish'),
          h('button', { class: 'btn sm bad', onclick: async () => { if (await confirmBox(`Permanently delete "${p.name}"? Past orders keep their own copy of the item.`, 'Delete product', true)) { try { await api('DELETE', '/products/' + p.id); toast('Deleted'); load(); } catch (e) { fail(e); } } } }, 'Delete')) : null) },
      ], rows, 'No products match. Use "Add product" to create one.'));
    }
    await load();
  }
  async function editProduct(id, after) {
    let p = id ? await api('GET', '/products/' + id) : { published: false, stock: 0, low_stock: 3, icon: 'Bags', tint: '#E8E5E0', variants: [], images: [] };
    const fin = can('finance:r');
    const specs = [
      { k: 'name', label: 'Product name', req: true, wide: true, max: 120 }, { k: 'brand', label: 'Brand', max: 60 }, { k: 'sku', label: 'SKU', max: 60 },
      { k: 'category_id', label: 'Category', type: 'select', req: true, opts: [['', 'Choose…'], ...CATS.map((c) => [c.id, c.name])] },
      { k: 'supplier_id', label: 'Supplier (private)', type: 'select', skip: !fin || !can('suppliers:r'), opts: [['', 'None'], ...SUPPLIERS.map((s) => [s.id, s.name])] },
      { k: 'price', label: 'Selling price', type: 'number', step: '0.01', req: true, mode: 'decimal' },
      { k: 'compare_price', label: 'Original price (shows an offer)', type: 'number', step: '0.01', hint: 'Must be higher than the selling price' },
      { k: 'cost_price', label: 'Supplier purchase price (private)', type: 'number', step: '0.01', skip: !fin, hint: 'Used only for profit. Never shown to customers.' },
      { k: 'stock', label: 'Stock (when no variants)', type: 'number', step: '1', mode: 'numeric' }, { k: 'low_stock', label: 'Low-stock alert at', type: 'number', step: '1' },
      { k: 'caption', label: 'Caption', wide: true, max: 200 }, { k: 'description', label: 'Description', type: 'textarea', rows: 4, wide: true },
      { k: 'icon', label: 'Icon (when no photo)', type: 'select', opts: ME.icons.map((i) => [i, i]) }, { k: 'tint', label: 'Card colour', type: 'color' },
      { k: 'internal_notes', label: 'Internal notes (private)', type: 'textarea', wide: true, skip: !fin }, { k: 'published', label: 'Published (visible to customers)', type: 'checkbox' },
    ];
    const f = form(specs, p);
    let variants = (p.variants || []).map((x) => ({ ...x }));
    const vbox = h('div', {});
    const drawV = () => vbox.replaceChildren(...variants.map((x, i) => h('div', { class: 'vrow' },
      h('input', { placeholder: 'Option name (e.g. Black / M)', value: x.name, oninput: (e) => { x.name = e.target.value; } }), h('input', { placeholder: 'SKU', value: x.sku || '', oninput: (e) => { x.sku = e.target.value; } }),
      h('input', { type: 'number', min: '0', placeholder: 'Stock', value: x.stock == null ? 0 : x.stock, oninput: (e) => { x.stock = e.target.value; } }),
      h('button', { class: 'btn sm bad', onclick: () => { variants.splice(i, 1); drawV(); } }, 'Remove'))));
    drawV();
    const ibox = h('div', {});
    async function drawI() {
      if (!p.id) { ibox.replaceChildren(h('div', { class: 'note info' }, 'Save the product first, then add photos.')); return; }
      p = await api('GET', '/products/' + p.id);
      const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, onchange: async (e) => {
        for (const fl of e.target.files) { try { await api('POST', '/products/' + p.id + '/images', { data: await readImage(fl) }); } catch (er) { fail(er); } }
        e.target.value = ''; drawI(); after();
      } });
      ibox.replaceChildren(h('div', { class: 'imgs' }, ...p.images.map((im, i) => h('figure', {}, h('img', { src: imgUrl(im.media_id), alt: 'Product photo ' + (i + 1) }), h('figcaption', {},
        i ? h('button', { class: 'btn sm', onclick: async () => { await api('POST', `/products/${p.id}/images/${im.id}/cover`, {}); drawI(); after(); } }, 'Cover') : h('span', { class: 'pill ok' }, 'Cover'),
        h('button', { class: 'btn sm bad', onclick: async () => { await api('DELETE', `/products/${p.id}/images/${im.id}`); drawI(); after(); } }, '✕'))))),
        p.images.length < 8 ? h('label', { class: 'fld', style: { marginTop: '10px' } }, h('span', {}, 'Add photos (JPEG, PNG or WebP, up to 8)'), file) : null);
    }
    const btn = h('button', { class: 'btn pri' }, id ? 'Save changes' : 'Create product');
    const m = modal(id ? 'Edit product' : 'New product', h('div', {}, f.el,
      h('h3', { style: { margin: '18px 0 6px' } }, 'Variants'), h('p', { class: 'sm' }, 'Sizes, colours or models. When variants exist, stock is tracked per variant and customers must choose one.'), vbox,
      h('button', { class: 'btn sm', onclick: () => { variants.push({ name: '', sku: '', stock: 0 }); drawV(); } }, '+ Add variant'),
      h('h3', { style: { margin: '18px 0 6px' } }, 'Photos'), ibox, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Close'), btn)), { wide: true });
    drawI();
    btn.addEventListener('click', () => run(btn, async () => {
      f.errors(null); const body = f.collect(); body.variants = variants.map((x) => ({ id: x.id, name: x.name, sku: x.sku, stock: x.stock }));
      if (p.id) { await api('PUT', '/products/' + p.id, body); toast('Product saved'); after(); const fresh = await api('GET', '/products/' + p.id); variants = fresh.variants; drawV(); }
      else { const r = await api('POST', '/products', body); toast('Product created. You can add photos now.'); m.close(); after(); editProduct(r.id, after); }
    }, f));
  }

  // =====================================================================
  // CATEGORIES / SUPPLIERS / PROMOTIONS
  // =====================================================================
  async function viewCategories(v) {
    const out = h('div', { class: 'card' });
    const specs = [{ k: 'name', label: 'Name', req: true, max: 40 }, { k: 'sort', label: 'Sort order', type: 'number', step: '1' }, { k: 'icon', label: 'Icon', type: 'select', opts: ME.icons.map((i) => [i, i]) },
      { k: 'tint', label: 'Tile colour', type: 'color' }, { k: 'published', label: 'Visible on the website', type: 'checkbox' }];
    const reload = async () => { CATS = await api('GET', '/categories'); draw(); };
    function draw() {
      out.replaceChildren(table([{ h: 'Category', c: (c) => h('b', {}, c.name) }, { h: 'Products', c: (c) => c.products }, { h: 'Order', c: (c) => c.sort },
        { h: 'Website', c: (c) => h('span', { class: 'pill ' + (c.published ? 'ok' : '') }, c.published ? 'Visible' : 'Hidden') },
        { h: '', c: (c) => (can('categories:w') ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => recordModal('Edit category', specs, { ...c, published: !!c.published }, (d) => api('PUT', '/categories/' + c.id, d), reload) }, 'Edit'),
          h('button', { class: 'btn sm bad', onclick: async () => { if (await confirmBox(`Delete category "${c.name}"?`, 'Delete', true)) { try { await api('DELETE', '/categories/' + c.id); reload(); } catch (e) { fail(e); } } } }, 'Delete')) : null) }], CATS, 'No categories yet'));
    }
    v.append(head('Categories', 'Group products for the storefront.', can('categories:w') && h('button', { class: 'btn pri', onclick: () => recordModal('New category', specs, { published: true, sort: CATS.length + 1, icon: 'Bags', tint: '#E8E5E0' }, (d) => api('POST', '/categories', d), reload) }, '+ Add category')), out);
    await reload();
  }
  async function viewSuppliers(v) {
    const out = h('div', { class: 'card' });
    const specs = [{ k: 'name', label: 'Supplier name', req: true, max: 80 }, { k: 'contact', label: 'Contact person' }, { k: 'phone', label: 'Phone / WhatsApp' }, { k: 'email', label: 'Email', type: 'email' },
      { k: 'website', label: 'Website', hint: 'https://…' }, { k: 'lead_days', label: 'Typical delivery (days)', type: 'number', step: '1' }, { k: 'notes', label: 'Private notes', type: 'textarea', wide: true }];
    const reload = async () => { SUPPLIERS = await api('GET', '/suppliers'); draw(); };
    function draw() {
      out.replaceChildren(table([{ h: 'Supplier', c: (s) => h('div', {}, h('b', {}, s.name), h('span', { class: 'sub' }, s.contact || '')) }, { h: 'Phone', c: (s) => s.phone || '—' }, { h: 'Email', c: (s) => s.email || '—' },
        { h: 'Lead time', c: (s) => (s.lead_days == null ? '—' : s.lead_days + ' days') }, { h: 'Products', c: (s) => s.products },
        { h: '', c: (s) => (can('suppliers:w') ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => recordModal('Edit supplier', specs, s, (d) => api('PUT', '/suppliers/' + s.id, d), reload) }, 'Edit'),
          h('button', { class: 'btn sm bad', onclick: async () => { if (await confirmBox(`Delete supplier "${s.name}"? Products keep working without a supplier.`, 'Delete', true)) { await api('DELETE', '/suppliers/' + s.id); reload(); } } }, 'Delete')) : null) }], SUPPLIERS, 'No suppliers yet'));
    }
    v.append(head('Suppliers', 'Private records. Never shown to customers.', can('suppliers:w') && h('button', { class: 'btn pri', onclick: () => recordModal('New supplier', specs, {}, (d) => api('POST', '/suppliers', d), reload) }, '+ Add supplier')), out);
    await reload();
  }
  async function viewPromotions(v) {
    const out = h('div', { class: 'card' });
    const specs = [{ k: 'code', label: 'Code', req: true, max: 30, hint: 'Letters, numbers, - or _' }, { k: 'kind', label: 'Type', type: 'select', opts: [['percent', 'Percent off'], ['fixed', 'Fixed amount off']] },
      { k: 'value', label: 'Value', type: 'number', step: '0.01', req: true }, { k: 'min_subtotal', label: 'Minimum order', type: 'number', step: '0.01' }, { k: 'usage_limit', label: 'Usage limit', type: 'number', step: '1', hint: 'Empty = unlimited' },
      { k: 'starts', label: 'Starts', type: 'date' }, { k: 'ends', label: 'Ends', type: 'date' }, { k: 'active', label: 'Active', type: 'checkbox' }];
    const toVals = (p) => ({ ...p, active: !!p.active, starts: p.starts_at ? new Date(p.starts_at).toISOString().slice(0, 10) : '', ends: p.ends_at ? new Date(p.ends_at - 1).toISOString().slice(0, 10) : '' });
    async function reload() {
      const rows = await api('GET', '/promotions');
      out.replaceChildren(table([{ h: 'Code', c: (p) => h('b', {}, p.code) }, { h: 'Discount', c: (p) => (p.kind === 'percent' ? p.value + '%' : money(p.value)) }, { h: 'Min order', c: (p) => money(p.min_subtotal) },
        { h: 'Used', c: (p) => p.used + (p.usage_limit ? ' / ' + p.usage_limit : '') }, { h: 'Dates', c: (p) => (p.starts_at || p.ends_at ? fd(p.starts_at) + ' → ' + fd(p.ends_at) : 'Always') },
        { h: 'Status', c: (p) => h('span', { class: 'pill ' + (p.active ? 'ok' : '') }, p.active ? 'Active' : 'Off') },
        { h: '', c: (p) => (can('promotions:w') ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => recordModal('Edit promotion', specs, toVals(p), (d) => api('PUT', '/promotions/' + p.id, d), reload) }, 'Edit'),
          h('button', { class: 'btn sm bad', onclick: async () => { if (await confirmBox(`Delete code ${p.code}?`, 'Delete', true)) { await api('DELETE', '/promotions/' + p.id); reload(); } } }, 'Delete')) : null) }], rows, 'No promotions yet'));
    }
    v.append(head('Promotions', 'Discount codes are checked on the server when a customer sends a request. Usage counts when you confirm the order.',
      can('promotions:w') && h('button', { class: 'btn pri', onclick: () => recordModal('New promotion', specs, { kind: 'percent', active: true }, (d) => api('POST', '/promotions', d), reload) }, '+ Add promotion')), out);
    await reload();
  }

  // =====================================================================
  // INVENTORY
  // =====================================================================
  async function viewInventory(v) {
    const q = h('input', { type: 'search', placeholder: 'Search product or SKU' }), low = h('input', { type: 'checkbox' });
    const out = h('div', { class: 'card' }), moves = h('div', { class: 'card' });
    v.append(head('Inventory', 'Stock per product or variant. Stock is deducted only when you confirm an order.'), h('div', { class: 'row bar', style: { marginBottom: '14px' } }, q, h('label', { class: 'row' }, low, ' Low stock only')), out, moves);
    async function load() {
      let rows = await api('GET', '/inventory'); const t = q.value.toLowerCase();
      rows = rows.filter((r) => (!t || (r.name + ' ' + (r.variant_name || '') + ' ' + (r.sku || '')).toLowerCase().includes(t)) && (!low.checked || r.stock <= r.low_stock));
      out.replaceChildren(table([{ h: 'Item', c: (r) => h('div', {}, h('b', {}, r.name), r.variant_name && h('span', { class: 'sub' }, r.variant_name)) }, { h: 'SKU', c: (r) => r.sku || '—' },
        { h: 'On hand', c: (r) => h('span', { class: 'pill ' + (r.stock <= 0 ? 'bad' : r.stock <= r.low_stock ? 'warn' : 'ok') }, r.stock) }, { h: 'Listed', c: (r) => (r.published ? 'Yes' : 'Draft') },
        { h: '', c: (r) => (can('inventory:w') ? h('button', { class: 'btn sm', onclick: () => recordModal('Adjust stock: ' + r.name + (r.variant_name ? ' (' + r.variant_name + ')' : ''),
          [{ k: 'delta', label: 'Change (+ adds, − removes)', type: 'number', step: '1', req: true, hint: 'Current stock: ' + r.stock }, { k: 'reason', label: 'Reason', req: true, wide: true, max: 120 }], { delta: '' },
          (d) => api('POST', '/inventory/adjust', { product_id: r.product_id, variant_id: r.variant_id, delta: d.delta, reason: d.reason }), load) }, 'Adjust') : null) }], rows, 'No stock items match'));
      const mv = await api('GET', '/inventory/moves');
      moves.replaceChildren(h('h3', {}, 'Recent stock movements'), table([{ h: 'When', c: (m) => fdt(m.ts) }, { h: 'Item', c: (m) => m.product_name + (m.variant_name ? ' (' + m.variant_name + ')' : '') },
        { h: 'Change', c: (m) => h('span', { class: 'pill ' + (m.delta < 0 ? 'warn' : 'ok') }, (m.delta > 0 ? '+' : '') + m.delta) }, { h: 'Reason', c: (m) => m.reason }, { h: 'By', c: (m) => m.username || 'system' }], mv, 'No movements yet'));
    }
    let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 200); }); low.addEventListener('change', load);
    await load();
  }

  // =====================================================================
  // ORDERS and WHATSAPP REQUESTS
  // =====================================================================
  async function viewOrders(v, requests) {
    const q = h('input', { type: 'search', placeholder: 'Search code, name or phone' });
    const stt = h('select', {}, h('option', { value: '' }, requests ? 'All open requests' : 'All statuses'), ...ME.statuses.filter((s) => !requests || ['new_request', 'contacted', 'awaiting_payment'].includes(s)).map((s) => h('option', { value: s }, label(s))));
    const out = h('div', { class: 'card' }), pager = h('div', { class: 'row sp' });
    let offset = 0; const LIM = 25;
    v.append(head(requests ? 'WhatsApp requests' : 'Orders', requests ? 'Requests customers sent from the website. Nothing is confirmed until you confirm it here.' : 'All orders and their manually managed status.'),
      requests ? h('div', { class: 'note info' }, 'Opening WhatsApp never changes a status. Message the customer, agree details and payment, then move the request forward yourself.') : null,
      h('div', { class: 'row bar', style: { marginBottom: '14px' } }, q, stt), out, pager);
    async function load() {
      const r = await api('GET', '/orders?' + qs({ q: q.value.trim(), status: stt.value, group: requests && !stt.value ? 'requests' : '', limit: LIM, offset }));
      out.replaceChildren(table([
        { h: 'Order', c: (o) => h('button', { class: 'btn sm', onclick: () => openOrder(o.id, load) }, o.code) }, { h: 'Customer', c: (o) => h('div', {}, o.name, can('customers:r') ? h('span', { class: 'sub' }, o.phone) : null) },
        { h: 'Items', c: (o) => o.items }, { h: 'Total', c: (o) => money(o.total) }, { h: 'Status', c: (o) => pill(o.status) }, { h: 'Received', c: (o) => fdt(o.created_at) },
        ...(requests ? [{ h: '', c: (o) => h('button', { class: 'btn sm', onclick: () => waOpen(o.id, 'confirm') }, 'Message on WhatsApp') }] : [])], r.rows, requests ? 'No open requests. New ones appear here.' : 'No orders found'));
      pager.replaceChildren(h('span', { class: 'sm' }, r.total ? `${offset + 1}–${Math.min(offset + LIM, r.total)} of ${r.total}` : ''),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - LIM); load(); } }, 'Previous'), h('button', { class: 'btn sm', disabled: offset + LIM >= r.total, onclick: () => { offset += LIM; load(); } }, 'Next')));
    }
    let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { offset = 0; load(); }, 250); }); stt.addEventListener('change', () => { offset = 0; load(); });
    await load();
  }
  async function waOpen(id, kind) {
    try { const t = await api('GET', `/orders/${id}/wa-template?kind=${kind}`); window.open('https://wa.me/' + t.phone + '?text=' + encodeURIComponent(t.text), '_blank', 'noopener'); } catch (e) { fail(e); }
  }
  async function openOrder(id, after) {
    const wrap = h('div', {});
    const m = modal('Order', wrap, { wide: true, onClose: () => after && after() });
    async function draw() {
      const o = await api('GET', '/orders/' + id), fin = !!o.profit;
      m.box.querySelector('.mh h2').textContent = 'Order ' + o.code;
      const items = table([{ h: 'Item', c: (i) => h('div', {}, h('b', {}, i.name), i.variant_name && h('span', { class: 'sub' }, i.variant_name)) }, { h: 'Qty', c: (i) => i.qty }, { h: 'Price', c: (i) => money(i.unit_price) },
        ...(fin ? [{ h: 'Supplier cost', c: (i) => (i.unit_cost == null ? h('span', { class: 'pill warn' }, 'not recorded') : money(i.unit_cost)) }, { h: 'Supplier', c: (i) => i.supplier_name || '—' }] : []), { h: 'Line total', c: (i) => money(i.qty * i.unit_price) }], o.items);
      const statusCard = o.allowed_next.length && can('orders:status') ? (() => {
        const sel = h('select', {}, ...o.allowed_next.map((s) => h('option', { value: s }, label(s))));
        const f = form([{ k: 'note', label: 'Internal note (private)', wide: true, max: 500 }, { k: 'public_note', label: 'Message customers see when tracking', wide: true, max: 300 },
          { k: 'country', label: 'Current country' }, { k: 'state', label: 'State' }, { k: 'district', label: 'District' }, { k: 'place', label: 'Place / hub' }]);
        const btn = h('button', { class: 'btn dark' }, 'Update status');
        btn.addEventListener('click', async () => {
          const to = sel.value, risky = to === 'confirmed' || to === 'cancelled';
          if (risky && !(await confirmBox(to === 'confirmed' ? 'Confirm this order? Stock will be deducted and it will count as a sale.' : 'Cancel this order? Any committed stock is returned.', label(to), to === 'cancelled'))) return;
          run(btn, async () => { await api('POST', `/orders/${id}/status`, { status: to, ...f.collect() }); toast('Status updated to ' + label(to)); await draw(); }, f);
        });
        return h('div', { class: 'card' }, h('h3', {}, 'Update status'), h('div', { class: 'row' }, h('label', { class: 'fld' }, h('span', {}, 'New status'), sel)), f.el, h('div', { class: 'actions' }, btn));
      })() : null;
      const refundable = ['confirmed', 'ordered_from_supplier', 'shipped', 'out_for_delivery', 'delivered', 'refunded'].includes(o.status);
      const exp = fin ? h('div', { class: 'card' }, h('h3', {}, 'Costs, expenses & refunds'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Revenue'), h('dd', {}, money(o.profit.revenue)), h('dt', {}, 'Supplier cost'), h('dd', {}, money(o.profit.cogs) + (o.profit.complete ? '' : ' (incomplete)')),
          h('dt', {}, 'Order expenses'), h('dd', {}, money(o.profit.expenses)), h('dt', {}, 'Refunded'), h('dd', {}, money(o.profit.refunded)),
          h('dt', {}, 'Profit'), h('dd', {}, o.profit.complete ? h('b', {}, money(o.profit.profit)) : h('span', { class: 'pill warn' }, `unknown: ${o.profit.missing_costs} item(s) have no supplier cost`))),
        o.expenses.length ? table([{ h: 'Expense', c: (e) => e.kind.replace('_', ' ') }, { h: 'Amount', c: (e) => money(e.amount) }, { h: 'Note', c: (e) => e.note || '' }], o.expenses) : null,
        can('finance:w') ? h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: () => recordModal('Add expense to this order',
          [{ k: 'kind', label: 'Type', type: 'select', opts: [['shipping_cost', 'Shipping paid'], ['packaging', 'Packaging'], ['payment_fee', 'Payment fee'], ['other', 'Other']] }, { k: 'amount', label: 'Amount', type: 'number', step: '0.01', req: true }, { k: 'note', label: 'Note', wide: true }],
          { kind: 'shipping_cost' }, (d) => api('POST', `/orders/${id}/expenses`, d), draw) }, '+ Expense'),
        refundable ? h('button', { class: 'btn sm bad', onclick: () => recordModal('Record a refund',
          [{ k: 'amount', label: 'Refund amount', type: 'number', step: '0.01', req: true, hint: 'Order total ' + money(o.total) }, { k: 'note', label: 'Note', wide: true }, { k: 'restock', label: 'Return the items to stock', type: 'checkbox' }],
          {}, (d) => api('POST', `/orders/${id}/refund`, d), draw) }, 'Record refund') : null) : null) : null;
      wrap.replaceChildren(
        h('div', { class: 'row sp' }, h('div', { class: 'row' }, pill(o.status), h('span', { class: 'sm' }, 'Received ' + fdt(o.created_at) + (o.confirmed_at ? ' · confirmed ' + fdt(o.confirmed_at) : ''))), h('b', {}, 'Total ' + money(o.total))),
        h('div', { class: 'card', style: { marginTop: '12px' } }, h('div', { class: 'row sp' }, h('h3', {}, 'Customer'), can('orders:w') ? h('button', { class: 'btn sm', onclick: () => editOrder(o, draw) }, 'Edit details') : null),
          h('dl', { class: 'kv' }, h('dt', {}, 'Name'), h('dd', {}, o.name), h('dt', {}, 'Phone'), h('dd', {}, o.phone), h('dt', {}, 'Address'), h('dd', {}, o.address), h('dt', {}, 'Pincode'), h('dd', {}, o.pincode),
            o.promo_code ? [h('dt', {}, 'Promo'), h('dd', {}, o.promo_code)] : null, h('dt', {}, 'Internal notes'), h('dd', {}, o.internal_notes || '—')),
          h('div', { class: 'row', style: { marginTop: '12px' } }, h('span', { class: 'sm' }, 'Message on WhatsApp (does not change the status):'),
            ...[['confirm', 'Confirm details'], ['payment', 'Ask for payment'], ['update', 'Send update'], ['custom', 'Blank message']].map(([k, t]) => h('button', { class: 'btn sm', onclick: () => waOpen(id, k) }, t)))),
        h('div', { class: 'card' }, h('h3', {}, 'Items'), items, h('dl', { class: 'kv', style: { marginTop: '10px' } }, h('dt', {}, 'Subtotal'), h('dd', {}, money(o.subtotal)), h('dt', {}, 'Discount'), h('dd', {}, '− ' + money(o.discount)), h('dt', {}, 'Delivery'), h('dd', {}, money(o.shipping)), h('dt', {}, 'Total'), h('dd', {}, h('b', {}, money(o.total))))),
        statusCard, exp,
        h('div', { class: 'card' }, h('h3', {}, 'History'), h('ul', { class: 'timeline' }, ...o.events.map((e) => h('li', {}, h('b', {}, label(e.status)), ' ', h('small', {}, fdt(e.ts) + (e.username ? ' · ' + e.username : '')),
          e.note ? h('small', {}, 'Internal: ' + e.note) : null, e.public_note ? h('small', {}, 'Customer sees: ' + e.public_note) : null, (e.country || e.state || e.district || e.place) ? h('small', {}, 'Location: ' + [e.place, e.district, e.state, e.country].filter(Boolean).join(', ')) : null)))));
    }
    try { await draw(); } catch (e) { fail(e); m.close(); }
  }
  function editOrder(o, done) {
    const fin = can('finance:w'), f = form([{ k: 'name', label: 'Customer name', req: true }, { k: 'phone', label: 'Phone', req: true }, { k: 'address', label: 'Address', type: 'textarea', wide: true, req: true },
      { k: 'pincode', label: 'Pincode', req: true }, { k: 'shipping', label: 'Delivery charge', type: 'number', step: '0.01' }, { k: 'discount', label: 'Discount', type: 'number', step: '0.01' },
      { k: 'internal_notes', label: 'Internal notes (private)', type: 'textarea', wide: true }], o);
    const costs = fin ? o.items.map((i) => ({ id: i.id, name: i.name + (i.variant_name ? ' (' + i.variant_name + ')' : ''), cost: h('input', { type: 'number', step: '0.01', min: '0', value: i.unit_cost == null ? '' : i.unit_cost, placeholder: 'Unit cost' }),
      sup: h('select', {}, h('option', { value: '' }, 'No supplier'), ...SUPPLIERS.map((s) => h('option', { value: s.id, selected: s.id === i.supplier_id }, s.name))) })) : [];
    const btn = h('button', { class: 'btn pri' }, 'Save');
    const m = modal('Edit order details', h('div', {}, f.el, fin ? h('div', {}, h('h3', { style: { margin: '16px 0 6px' } }, 'Supplier cost per item (private)'), h('p', { class: 'sm' }, 'Record what you pay the supplier. Profit is only calculated from recorded costs.'),
      ...costs.map((c) => h('div', { class: 'vrow', style: { gridTemplateColumns: '2fr 1fr 1.5fr' } }, h('div', {}, c.name), c.cost, c.sup))) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), btn)));
    btn.addEventListener('click', () => run(btn, async () => {
      f.errors(null); const b = f.collect(); b.items = costs.map((c) => ({ id: c.id, unit_cost: c.cost.value, supplier_id: c.sup.value }));
      await api('PUT', '/orders/' + o.id, b); toast('Order updated'); m.close(); done();
    }, f));
  }

  // =====================================================================
  // CUSTOMERS
  // =====================================================================
  async function viewCustomers(v) {
    const q = h('input', { type: 'search', placeholder: 'Search name or phone' }), out = h('div', { class: 'card' });
    v.append(head('Customers', 'Personal data. Access is limited to staff who need it and every change is logged.'), h('div', { class: 'row bar', style: { marginBottom: '14px' } }, q), out);
    async function load() {
      const rows = await api('GET', '/customers?' + qs({ q: q.value.trim(), limit: 200 }));
      out.replaceChildren(table([{ h: 'Customer', c: (c) => h('b', {}, c.name) }, { h: 'Phone', c: (c) => c.phone }, { h: 'Orders', c: (c) => c.orders }, { h: 'Confirmed spend', c: (c) => money(c.spent) }, { h: 'Since', c: (c) => fd(c.created_at) },
        { h: '', c: (c) => h('button', { class: 'btn sm', onclick: () => openCustomer(c.id, load) }, 'Open') }], rows, 'No customers yet. They are created from WhatsApp requests.'));
    }
    let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 250); }); await load();
  }
  async function openCustomer(id, after) {
    const c = await api('GET', '/customers/' + id);
    const f = form([{ k: 'name', label: 'Name', req: true }, { k: 'email', label: 'Email', type: 'email' }, { k: 'address', label: 'Address', type: 'textarea', wide: true }, { k: 'pincode', label: 'Pincode' }, { k: 'notes', label: 'Private notes', type: 'textarea', wide: true }], c);
    const btn = h('button', { class: 'btn pri' }, 'Save');
    const m = modal(c.name, h('div', {}, h('p', { class: 'sm' }, 'Phone: ' + c.phone), f.el, h('h3', { style: { margin: '16px 0 6px' } }, 'Orders'),
      table([{ h: 'Order', c: (o) => h('button', { class: 'btn sm', onclick: () => openOrder(o.id) }, o.code) }, { h: 'Status', c: (o) => pill(o.status) }, { h: 'Total', c: (o) => money(o.total) }, { h: 'Date', c: (o) => fdt(o.created_at) }], c.orders, 'No orders'),
      can('customers:w') ? h('div', { class: 'actions' }, h('button', { class: 'btn bad', onclick: async () => { if (await confirmBox('Erase this customer\'s personal data? Name, phone and address are removed from the customer record and their orders. This cannot be undone.', 'Erase data', true)) { try { await api('POST', `/customers/${id}/anonymize`, {}); toast('Customer data erased'); m.close(); after(); } catch (e) { fail(e); } } } }, 'Erase personal data'), btn) : null), { wide: true });
    btn.addEventListener('click', () => run(btn, async () => { f.errors(null); await api('PUT', '/customers/' + id, f.collect()); toast('Saved'); m.close(); after(); }, f));
  }

  // =====================================================================
  // WEBSITE SETTINGS
  // =====================================================================
  async function viewSettings(v) {
    let S = await api('GET', '/settings'), tab = 'general'; const body = h('div', {}), tabs = h('div', { class: 'tabs' });
    const T = [['general', 'General'], ['branding', 'Logo & announcement'], ['banners', 'Banners'], ['home', 'Homepage'], ['contact', 'Contact'], ['policies', 'Policies']];
    const save = async (patch) => { S = await api('PUT', '/settings', patch); if (patch.currency) CUR = S.currency; toast('Settings saved'); };
    const catOpts = [['', 'Any'], ...CATS.map((c) => [c.name, c.name])];
    function formCard(title, specs, vals, toPatch, note) {
      const f = form(specs, vals), btn = h('button', { class: 'btn pri' }, 'Save');
      btn.addEventListener('click', () => run(btn, async () => { f.errors(null); await save(toPatch(f.collect())); }, f));
      return h('div', { class: 'card' }, h('h3', {}, title), note, f.el, h('div', { class: 'actions' }, btn));
    }
    async function upload(file) { const r = await api('POST', '/media', { data: await readImage(file) }); return r.id; }
    function draw() {
      tabs.replaceChildren(...T.map(([k, t]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, t)));
      if (tab === 'general') body.replaceChildren(formCard('Store & ordering', [{ k: 'store_name', label: 'Store name', req: true }, { k: 'whatsapp_number', label: 'WhatsApp number for orders', req: true, hint: 'Country code + number, digits only. Customers cannot send requests until this is set.', mode: 'tel' },
        { k: 'currency', label: 'Currency symbol', req: true }, { k: 'free_over', label: 'Free delivery over', type: 'number', step: '0.01' }, { k: 'shipping', label: 'Delivery charge below that', type: 'number', step: '0.01' }], S, (d) => d));
      else if (tab === 'branding') {
        const logoRow = (key, title, hint) => {
          const img = S[key] ? h('img', { src: imgUrl(S[key]), alt: title, class: 'logoprev' }) : h('div', { class: 'sm' }, 'Not set. The built-in default is used.');
          const inp = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', onchange: async (e) => { if (!e.target.files[0]) return; try { const id = await upload(e.target.files[0]); await save({ [key]: id }); draw(); } catch (er) { fail(er); } } });
          return h('div', { class: 'card' }, h('h3', {}, title), h('p', { class: 'sm' }, hint), img, h('div', { class: 'row', style: { marginTop: '10px' } }, inp, S[key] ? h('button', { class: 'btn sm bad', onclick: async () => { await save({ [key]: '' }); draw(); } }, 'Remove') : null));
        };
        body.replaceChildren(logoRow('logo_icon', 'Logo icon', 'Shown in the website header.'), logoRow('logo_wordmark', 'Logo wordmark', 'The store-name artwork shown next to the icon.'),
          formCard('Announcement bar', [{ k: 'announcement', label: 'Messages (one per line, up to 8)', type: 'textarea', rows: 5, wide: true }], { announcement: (S.announcement || []).join('\n') }, (d) => ({ announcement: d.announcement.split('\n').map((s) => s.trim()).filter(Boolean) })));
      } else if (tab === 'banners') {
        const list = (S.banners || []).map((b) => ({ ...b })), box = h('div', {});
        const drawB = () => box.replaceChildren(...list.map((b, i) => h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('b', {}, 'Banner ' + (i + 1)), h('div', { class: 'row' },
          h('button', { class: 'btn sm', disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; drawB(); } }, '↑'), h('button', { class: 'btn sm', disabled: i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; drawB(); } }, '↓'),
          h('button', { class: 'btn sm bad', onclick: () => { list.splice(i, 1); drawB(); } }, 'Remove'))),
          h('div', { class: 'grid2' }, h('label', { class: 'fld' }, h('span', {}, 'Title'), h('input', { value: b.title, maxlength: '80', oninput: (e) => { b.title = e.target.value; } })), h('label', { class: 'fld' }, h('span', {}, 'Subtitle'), h('input', { value: b.subtitle || '', maxlength: '160', oninput: (e) => { b.subtitle = e.target.value; } })),
            h('label', { class: 'fld' }, h('span', {}, 'Button opens category'), h('select', { onchange: (e) => { b.category = e.target.value; } }, ...catOpts.map((o) => h('option', { value: o[0], selected: o[0] === (b.category || '') }, o[1])))),
            h('div', { class: 'row' }, h('label', { class: 'fld' }, h('span', {}, 'Colour 1'), h('input', { type: 'color', value: b.c1 || '#1F2A24', oninput: (e) => { b.c1 = e.target.value; } })), h('label', { class: 'fld' }, h('span', {}, 'Colour 2'), h('input', { type: 'color', value: b.c2 || '#3B5246', oninput: (e) => { b.c2 = e.target.value; } }))),
            h('div', { class: 'fld wide' }, h('span', {}, 'Background image (optional)'), b.media ? h('img', { src: imgUrl(b.media), alt: '', class: 'bannerprev' }) : null,
              h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', onchange: async (e) => { if (e.target.files[0]) { try { b.media = await upload(e.target.files[0]); drawB(); } catch (er) { fail(er); } } } }), b.media ? h('button', { class: 'btn sm', onclick: () => { b.media = ''; drawB(); } }, 'Remove image') : null)))));
        drawB(); const sb = h('button', { class: 'btn pri' }, 'Save banners');
        sb.addEventListener('click', () => run(sb, async () => { await save({ banners: list.map((b) => ({ title: b.title, subtitle: b.subtitle || '', category: b.category || '', c1: b.c1 || '#1F2A24', c2: b.c2 || '#3B5246', media: b.media || '' })) }); draw(); }));
        body.replaceChildren(h('div', { class: 'row sp', style: { marginBottom: '12px' } }, h('p', { class: 'sm' }, 'Shown in the homepage carousel. Up to 6.'), h('div', { class: 'row' }, list.length < 6 ? h('button', { class: 'btn', onclick: () => { list.push({ title: 'New banner', subtitle: '', category: '', c1: '#1F2A24', c2: '#3B5246' }); drawB(); } }, '+ Add banner') : null, sb)), box);
      } else if (tab === 'home') {
        const list = (S.home_sections || []).map((s) => ({ ...s })), box = h('div', { class: 'card' });
        const TYPES = [['categories', 'Category tiles'], ['deals', 'Deals (discounted products)'], ['bestsellers', 'Best sellers'], ['category', 'One category'], ['each_category', 'A row for every category']];
        const drawS = () => box.replaceChildren(table([{ h: 'Section', c: (s) => h('select', { onchange: (e) => { s.type = e.target.value; drawS(); } }, ...TYPES.map((t) => h('option', { value: t[0], selected: t[0] === s.type }, t[1]))) },
          { h: 'Title', c: (s) => h('input', { value: s.title || '', maxlength: '60', oninput: (e) => { s.title = e.target.value; } }) },
          { h: 'Category', c: (s) => (s.type === 'category' ? h('select', { onchange: (e) => { s.category = e.target.value; } }, ...catOpts.slice(1).map((o) => h('option', { value: o[0], selected: o[0] === s.category }, o[1]))) : '—') },
          { h: 'Show', c: (s) => h('input', { type: 'checkbox', checked: s.enabled, onchange: (e) => { s.enabled = e.target.checked; } }) },
          { h: '', c: (s) => { const i = list.indexOf(s); return h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; drawS(); } }, '↑'), h('button', { class: 'btn sm', disabled: i === list.length - 1, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; drawS(); } }, '↓'), h('button', { class: 'btn sm bad', onclick: () => { list.splice(i, 1); drawS(); } }, '✕')); } }], list, 'No sections. The homepage will show only the banners.'));
        drawS(); const sb = h('button', { class: 'btn pri' }, 'Save homepage');
        sb.addEventListener('click', () => run(sb, async () => { await save({ home_sections: list.map((s) => ({ type: s.type, title: s.title || '', category: s.category || '', enabled: !!s.enabled })) }); }));
        body.replaceChildren(h('div', { class: 'row sp', style: { marginBottom: '12px' } }, h('p', { class: 'sm' }, 'Choose and order the sections customers see under the banners.'), h('div', { class: 'row' }, list.length < 14 ? h('button', { class: 'btn', onclick: () => { list.push({ type: 'bestsellers', title: '', category: '', enabled: true }); drawS(); } }, '+ Add section') : null, sb)), box);
      } else if (tab === 'contact') body.replaceChildren(formCard('Contact details', [{ k: 'email', label: 'Email', type: 'email' }, { k: 'phone', label: 'Phone' }, { k: 'address', label: 'Address', type: 'textarea', wide: true }, { k: 'hours', label: 'Opening hours', wide: true }], S.contact || {}, (d) => ({ contact: d })));
      else body.replaceChildren(formCard('Store policies', [{ k: 'returns', label: 'Returns & refunds', type: 'textarea', rows: 5, wide: true }, { k: 'shipping', label: 'Shipping & delivery', type: 'textarea', rows: 5, wide: true },
        { k: 'privacy', label: 'Privacy policy', type: 'textarea', rows: 5, wide: true }, { k: 'terms', label: 'Terms of service', type: 'textarea', rows: 5, wide: true }], S.policies || {}, (d) => ({ policies: d }), h('p', { class: 'sm' }, 'Plain text, shown on the website exactly as written. Have a legal professional review your policies.')));
    }
    v.append(head('Website settings', 'Changes go live on the storefront immediately.'), tabs, body); draw();
  }

  function showRecovery(codes) {
    const ok = h('input', { type: 'checkbox' }), done = h('button', { class: 'btn pri', disabled: true }, 'Done');
    ok.addEventListener('change', () => { done.disabled = !ok.checked; });
    const m = modal('Save your recovery codes', h('div', {}, h('p', {}, 'If you lose your phone, each of these codes lets you sign in once. They are shown only now. Keep them in a password manager or print them.'),
      h('div', { class: 'sec rc' }, ...codes.map((c) => h('div', {}, c))),
      h('div', { class: 'row', style: { margin: '10px 0' } }, h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(codes.join('\n')); toast('Copied'); } catch { toast('Copy failed. Select and copy the codes by hand.', true); } } }, 'Copy all')),
      h('label', { class: 'fld chk' }, ok, h('span', {}, 'I have saved these codes somewhere safe')), h('div', { class: 'actions' }, done)));
    done.addEventListener('click', () => m.close());
  }
  // =====================================================================
  // SECURITY
  // =====================================================================
  async function viewSecurity(v) {
    let tab = 'account'; const owner = can('security:r'), body = h('div', {}), tabs = h('div', { class: 'tabs' });
    const T = [['account', 'My account'], ['sessions', 'Sessions'], ...(owner ? [['users', 'Staff'], ['audit', 'Audit log'], ['status', 'Security checklist']] : [])];
    async function draw() {
      tabs.replaceChildren(...T.map(([k, t]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, t)));
      body.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
      try { body.replaceChildren(await ({ account: secAccount, sessions: secSessions, users: secUsers, audit: secAudit, status: secStatus }[tab])()); } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, e.message)); }
    }
    v.append(head('Security', 'Passwords, two-factor authentication, sessions and the audit trail.'), tabs, body); await draw();
    async function secAccount() {
      const pf = form([{ k: 'current', label: 'Current password', type: 'password', req: true }, { k: 'next', label: 'New password', type: 'password', req: true, hint: 'At least 12 characters. Use a password manager.' }]);
      const pb = h('button', { class: 'btn pri' }, 'Change password');
      pb.addEventListener('click', () => run(pb, async () => { pf.errors(null); await api('POST', '/password', pf.collect()); toast('Password changed. Other sessions were signed out.'); pf.inputs.current.value = ''; pf.inputs.next.value = ''; }, pf));
      const tw = h('div', { class: 'card' });
      const fresh = async () => { const m = await api('GET', '/me'); ME = { ...ME, admin: m.admin }; };
      function twDraw() {
        if (ME.admin.totp_enabled) {
          const f = form([{ k: 'password', label: 'Password', type: 'password' }, { k: 'code', label: 'Current 6-digit code', mode: 'numeric', max: 6 }]), b = h('button', { class: 'btn bad' }, 'Turn off 2FA');
          b.addEventListener('click', () => run(b, async () => { f.errors(null); await api('POST', '/2fa/disable', f.collect()); await fresh(); toast('Two-factor turned off'); twDraw(); }, f));
          const rf = form([{ k: 'password', label: 'Password', type: 'password' }, { k: 'code', label: 'Current 6-digit code', mode: 'numeric', max: 6 }]), rb = h('button', { class: 'btn' }, 'Create new recovery codes');
          rb.addEventListener('click', () => run(rb, async () => { rf.errors(null); const r = await api('POST', '/2fa/recovery', rf.collect()); await fresh(); showRecovery(r.recovery_codes); twDraw(); }, rf));
          tw.replaceChildren(h('h3', {}, 'Two-factor authentication'), h('span', { class: 'pill ok' }, 'Enabled'), h('h4', { class: 'sub4' }, 'Recovery codes: ' + ME.admin.recovery_left + ' left'),
            h('p', { class: 'sm' }, 'Use one when you cannot reach your authenticator app. Creating new codes cancels the old ones.'), rf.el, h('div', { class: 'actions' }, rb),
            h('h4', { class: 'sub4' }, 'Turn off two-factor'), f.el, h('div', { class: 'actions' }, b));
        } else {
          const b = h('button', { class: 'btn dark' }, 'Set up two-factor');
          b.addEventListener('click', () => run(b, async () => {
            const s = await api('POST', '/2fa/setup', {}), f = form([{ k: 'code', label: 'Enter the 6-digit code from your app', mode: 'numeric', max: 6 }]), eb = h('button', { class: 'btn pri' }, 'Turn on');
            eb.addEventListener('click', () => run(eb, async () => { f.errors(null); const r = await api('POST', '/2fa/enable', f.collect()); await fresh(); toast('Two-factor enabled. Other sessions were signed out.'); showRecovery(r.recovery_codes); twDraw(); }, f));
            tw.replaceChildren(h('h3', {}, 'Two-factor authentication'), h('p', {}, 'In an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) add a time-based account and type in this key:'), h('div', { class: 'sec' }, s.secret),
              h('p', { class: 'sm' }, 'Account: ' + ME.admin.username + ' · 6 digits · 30 seconds · SHA-1'), f.el, h('div', { class: 'actions' }, eb));
          }));
          tw.replaceChildren(h('h3', {}, 'Two-factor authentication'), h('span', { class: 'pill warn' }, 'Not enabled'), h('p', { class: 'sm' }, 'Strongly recommended for every staff account. You will need a code from your phone each time you sign in.'), b);
        }
      }
      twDraw();
      return h('div', {}, h('div', { class: 'card' }, h('h3', {}, 'Change password'), pf.el, h('div', { class: 'actions' }, pb)), tw);
    }
    async function secSessions() {
      const rows = await api('GET', '/security/sessions' + (owner ? '?all=1' : ''));
      return h('div', { class: 'card' }, table([{ h: 'User', c: (s) => s.username }, { h: 'Signed in', c: (s) => fdt(s.created_at) }, { h: 'Last active', c: (s) => fdt(s.last_seen) }, { h: 'IP', c: (s) => s.ip || '—' }, { h: 'Device', c: (s) => (s.ua || '').slice(0, 50) },
        { h: '', c: (s) => (s.current ? h('span', { class: 'pill ok' }, 'This session') : h('button', { class: 'btn sm bad', onclick: async () => { await api('DELETE', '/security/sessions/' + s.id); draw(); } }, 'Sign out')) }], rows));
    }
    async function secUsers() {
      const rows = await api('GET', '/security/users'), wrap = h('div', { class: 'card' });
      const roles = [['owner', 'Owner: everything'], ['manager', 'Manager: store, orders, finance'], ['support', 'Support: orders and customers, no costs']];
      wrap.append(h('div', { class: 'row sp' }, h('h3', {}, 'Staff accounts'), h('button', { class: 'btn pri', onclick: () => recordModal('New staff account', [{ k: 'username', label: 'Username', req: true }, { k: 'name', label: 'Full name', req: true }, { k: 'role', label: 'Role', type: 'select', opts: roles },
        { k: 'password', label: 'Temporary password', type: 'password', req: true, hint: 'They must change it at first sign-in. Share it securely.' }], { role: 'support' }, (d) => api('POST', '/security/users', d), draw) }, '+ Add staff')),
      table([{ h: 'User', c: (u) => h('div', {}, h('b', {}, u.username), h('span', { class: 'sub' }, u.name)) }, { h: 'Role', c: (u) => u.role }, { h: '2FA', c: (u) => h('span', { class: 'pill ' + (u.totp_enabled ? 'ok' : 'warn') }, u.totp_enabled ? 'On' : 'Off') },
        { h: 'Status', c: (u) => (u.disabled ? h('span', { class: 'pill bad' }, 'Disabled') : u.locked_until > Date.now() ? h('span', { class: 'pill warn' }, 'Locked') : h('span', { class: 'pill ok' }, 'Active')) }, { h: 'Last sign-in', c: (u) => fdt(u.last_login) },
        { h: '', c: (u) => h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => recordModal('Edit ' + u.username, [{ k: 'name', label: 'Full name', req: true }, { k: 'role', label: 'Role', type: 'select', opts: roles }, { k: 'disabled', label: 'Disabled (cannot sign in)', type: 'checkbox' }], { ...u, disabled: !!u.disabled }, (d) => api('PUT', '/security/users/' + u.id, d), draw) }, 'Edit'),
          h('button', { class: 'btn sm', onclick: () => recordModal('Reset password for ' + u.username, [{ k: 'password', label: 'New temporary password', type: 'password', req: true }], {}, (d) => api('POST', `/security/users/${u.id}/reset-password`, d), draw) }, 'Reset password'),
          u.locked_until > Date.now() ? h('button', { class: 'btn sm', onclick: async () => { await api('POST', `/security/users/${u.id}/unlock`, {}); draw(); } }, 'Unlock') : null,
          u.totp_enabled && u.id !== ME.admin.id ? h('button', { class: 'btn sm bad', onclick: async () => { if (await confirmBox('Remove two-factor for ' + u.username + '? Use this only if they lost their device.', 'Remove 2FA', true)) { await api('POST', `/security/users/${u.id}/disable-2fa`, {}); draw(); } } }, 'Reset 2FA') : null) }], rows));
      return wrap;
    }
    async function secAudit() {
      const act = h('input', { placeholder: 'Filter by action (e.g. login, product)' }), out = h('div', {});
      async function load() {
        const rows = await api('GET', '/security/audit?' + qs({ action: act.value.trim(), limit: 100 }));
        out.replaceChildren(table([{ h: 'When', c: (a) => fdt(a.ts) }, { h: 'User', c: (a) => a.username || '—' }, { h: 'Action', c: (a) => h('span', { class: 'pill ' + (/failed|denied|blocked/.test(a.action) ? 'bad' : '') }, a.action) },
          { h: 'Target', c: (a) => [a.entity, a.entity_id].filter(Boolean).join(' ') }, { h: 'Details', c: (a) => h('span', { class: 'sm' }, (a.detail || '').slice(0, 140)) }, { h: 'IP', c: (a) => a.ip || '' }], rows, 'No entries'));
      }
      let tm; act.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 300); }); await load();
      return h('div', { class: 'card' }, h('div', { class: 'row bar', style: { marginBottom: '12px' } }, act, h('span', { class: 'sm' }, 'Append-only. Entries cannot be edited or deleted from the dashboard.')), out);
    }
    async function secStatus() {
      const s = await api('GET', '/security/status');
      return h('div', { class: 'card' }, h('h3', {}, 'Configuration checklist'), ...s.checks.map((c) => h('div', { class: 'check' }, h('span', { class: 'pill ' + (c.ok ? 'ok' : 'warn') }, c.ok ? 'OK' : 'Fix'), h('div', {}, h('b', {}, c.label), !c.ok && h('div', { class: 'sm' }, c.fix)))),
        h('p', { class: 'sm' }, `Admin path: ${s.admin_path} · rate limiting: ${s.rate_limiting} · staff accounts: ${s.admins}`));
    }
  }

  // =====================================================================
  // SHELL
  // =====================================================================
  const NAV = [['overview', 'Overview', null, viewOverview], ['products', 'Products', 'products:r', viewProducts], ['categories', 'Categories', 'categories:r', viewCategories], ['orders', 'Orders', 'orders:r', (v) => viewOrders(v, false)],
    ['requests', 'WhatsApp requests', 'orders:r', (v) => viewOrders(v, true)], ['customers', 'Customers', 'customers:r', viewCustomers], ['suppliers', 'Suppliers', 'suppliers:r', viewSuppliers], ['inventory', 'Inventory', 'inventory:r', viewInventory],
    ['promotions', 'Promotions', 'promotions:r', viewPromotions], ['settings', 'Website settings', 'settings:r', viewSettings], ['security', 'Security', null, viewSecurity]];
  async function showView(key) {
    const item = NAV.find((n) => n[0] === key && (!n[2] || can(n[2]))) || NAV[0];
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.k === item[0]));
    const view = document.getElementById('view'); view.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    document.querySelector('.side').classList.remove('open');
    const fresh = h('div', {});
    try { await item[3](fresh); } catch (e) { fresh.replaceChildren(h('div', { class: 'note' }, e.message)); }
    view.replaceChildren(...fresh.childNodes);
    window.scrollTo(0, 0);
  }
  function forcePassword() {
    const f = form([{ k: 'current', label: 'Temporary password', type: 'password', req: true }, { k: 'next', label: 'New password', type: 'password', req: true, hint: 'At least 12 characters.' }]), b = h('button', { class: 'btn pri' }, 'Set new password');
    b.addEventListener('click', () => run(b, async () => { f.errors(null); await api('POST', '/password', f.collect()); location.reload(); }, f));
    $app.replaceChildren(h('div', { class: 'view narrow' }, h('div', { class: 'card' }, h('h1', { class: 'pt' }, 'Choose a new password'), h('p', { class: 'lead' }, 'Your account uses a temporary password. Set your own to continue.'), f.el, h('div', { class: 'actions' }, b))));
  }
  async function boot() {
    try { ME = await api('GET', '/me'); } catch { $app.replaceChildren(h('div', { class: 'boot' }, 'Could not load. Reload the page.')); return; }
    CUR = ME.currency;
    if (ME.admin.must_change) return forcePassword();
    if (can('categories:r')) CATS = await api('GET', '/categories').catch(() => []);
    if (can('suppliers:r')) SUPPLIERS = await api('GET', '/suppliers').catch(() => []);
    let reqCount = 0; try { const o = await api('GET', '/overview'); reqCount = o.requests ? o.requests.new_request : 0; } catch { /* ignore */ }
    const side = h('aside', { class: 'side' }, h('div', { class: 'brand' }, h('i', {}, 'C'), h('div', {}, 'Cartitaz', h('small', {}, 'Control center'))),
      h('nav', { class: 'nav' }, ...NAV.filter((n) => !n[2] || can(n[2])).map((n) => h('button', { 'data-k': n[0], onclick: () => { location.hash = '#/' + n[0]; } }, n[1], n[0] === 'requests' && reqCount ? h('span', { class: 'badge' }, reqCount) : null))),
      h('div', { class: 'who' }, h('b', {}, ME.admin.name), ME.admin.role, h('br'), h('button', { onclick: async () => { try { await api('POST', '/logout', {}); } catch { /* ignore */ } location.reload(); } }, 'Sign out')));
    $app.replaceChildren(h('div', { class: 'shell' }, side, h('div', { class: 'main' }, h('div', { class: 'top' }, h('button', { 'aria-label': 'Menu', onclick: () => side.classList.toggle('open') }, '☰'), h('b', {}, 'Cartitaz control center')), h('main', { class: 'view', id: 'view' }))));
    window.addEventListener('hashchange', () => showView(location.hash.replace('#/', '')));
    showView(location.hash.replace('#/', ''));
  }
  boot();
})();
