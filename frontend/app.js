'use strict';

// ═════════════════════════ Utilidades ═════════════════════════

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* modo privado */ } },
};

const S = {
  token: store.get('asis_token'),
  user: null,
  evento: 'Mendotaku',
  timer: null,
  ctl: { fecha: null, turno: 'todos', estado: 'todos', q: '', data: null, firma: '', pendientes: 0 },
};

const can = (p) => !!S.user?.permisos.includes(p);

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Sin conexión con el servidor'), { offline: true });
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    salir();
    throw new Error(data?.error || 'Sesión vencida');
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Error ${res.status}`), { status: res.status, data });
  return data;
}

const hoy = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD en hora local
const fmtHora = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const fmtFecha = (f) => new Date(f + 'T12:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' });
const fmtFechaCorta = (f) => new Date(f + 'T12:00').toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtFechaHora = (iso) =>
  new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
function rangoTurno(t) {
  const ini = new Date(`${t.fecha}T${t.hora_inicio}`);
  let fin = new Date(`${t.fecha}T${t.hora_fin}`);
  if (fin <= ini) fin = new Date(fin.getTime() + 864e5); // cruza la medianoche
  return { ini, fin };
}
const aInputLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const desdeInputLocal = (v) => (v ? new Date(v).toISOString() : null);

// ═════════════════════════ Toasts y modales ═════════════════════════

function toast(msg, { tipo = '', accion, ms = 3500 } = {}) {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (accion) {
    const b = document.createElement('button');
    b.textContent = accion.label;
    b.onclick = () => { t.remove(); accion.fn(); };
    t.append(b);
    ms = Math.max(ms, 6000);
  }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
const toastError = (e) => toast(e.message || String(e), { tipo: 'error', ms: 5000 });

function modal({ title, body, actions = [], wide = false }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <header><h2>${esc(title)}</h2><button class="x" aria-label="Cerrar">×</button></header>
    <div class="mbody">${body}</div><footer></footer></div>`;
  const onKey = (e) => e.key === 'Escape' && close();
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  $('.x', ov).onclick = close;
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  document.addEventListener('keydown', onKey);
  const foot = $('footer', ov);
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${a.cls || ''}`;
    b.textContent = a.label;
    b.onclick = () => a.onClick(close, b);
    foot.append(b);
  }
  if (!actions.length) foot.remove();
  document.body.append(ov);
  return { el: ov, close };
}

function confirmar(msg, { ok = 'Confirmar', peligro = false, titulo = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let decidido = false;
    const m = modal({
      title: titulo,
      body: `<p style="margin:0">${esc(msg)}</p>`,
      actions: [
        { label: 'Cancelar', cls: 'ghost', onClick: (c) => c() },
        { label: ok, cls: peligro ? 'danger' : 'primary', onClick: (c) => { decidido = true; resolve(true); c(); } },
      ],
    });
    new MutationObserver((_, obs) => {
      if (!document.body.contains(m.el)) { obs.disconnect(); if (!decidido) resolve(false); }
    }).observe(document.body, { childList: true });
  });
}

function campo(f) {
  const id = `f_${f.name}`;
  const v = f.value ?? '';
  if (f.type === 'checkbox') {
    return `<label class="chkline"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''} ${f.disabled ? 'disabled' : ''}> ${esc(f.label)}</label>`;
  }
  let input;
  if (f.type === 'select') {
    const opt = (o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`;
    const grupos = [...new Set(f.options.map((o) => o.group).filter(Boolean))];
    input = `<select id="${id}" name="${f.name}">${
      grupos.length
        ? grupos.map((g) => `<optgroup label="${esc(g)}">${f.options.filter((o) => o.group === g).map(opt).join('')}</optgroup>`).join('')
        : f.options.map(opt).join('')
    }</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
  } else {
    input = `<input id="${id}" type="${f.type || 'text'}" name="${f.name}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"
      ${f.readonly ? 'readonly' : ''} ${f.attrs || ''}>`;
  }
  return `<label class="field ${f.half ? 'half' : ''}"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${input}${
    f.hint ? `<small>${esc(f.hint)}</small>` : ''
  }</label>`;
}

function formModal({ title, fields, submit = 'Guardar', onSubmit, extra = '', wide = false, onMount }) {
  const m = modal({
    title,
    wide,
    body: `<form class="form" novalidate>${fields.map(campo).join('')}${extra}<p class="err"></p><button type="submit" hidden></button></form>`,
    actions: [
      { label: 'Cancelar', cls: 'ghost', onClick: (c) => c() },
      { label: submit, cls: 'primary', onClick: () => form.requestSubmit() },
    ],
  });
  const form = $('form', m.el);
  const btn = $('footer .primary', m.el);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.err', form);
    err.textContent = '';
    const vals = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (!el) continue;
      vals[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
      if (f.required && !vals[f.name]) { err.textContent = `Completá: ${f.label}`; el.focus(); return; }
    }
    btn.disabled = true;
    try {
      await onSubmit(vals, m.close, form);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  };
  onMount?.(form, m);
  setTimeout(() => $('input:not([readonly]):not([type=checkbox]), select, textarea', form)?.focus(), 30);
  return m;
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = texto;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function descargarCSV(nombre, filas) {
  const celda = (v) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ═════════════════════════ Tema claro / oscuro ═════════════════════════

const temaActual = () =>
  document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const botonTema = () => {
  const oscuro = temaActual() === 'dark';
  const txt = oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
  return `<button class="temabtn" type="button" data-tema aria-label="${txt}" title="${txt}">${oscuro ? '☀️' : '🌙'}</button>`;
};
function alternarTema() {
  const nuevo = temaActual() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  store.set('tema', nuevo);
  $$('[data-tema]').forEach((b) => (b.outerHTML = botonTema()));
}
document.addEventListener('click', (e) => e.target.closest('[data-tema]') && alternarTema());

// ═════════════════════════ Sesión y navegación ═════════════════════════

function salir() {
  S.token = null;
  S.user = null;
  store.set('asis_token', null);
  clearInterval(S.timer);
  render();
}

const NAV = [
  ['control', 'Asistencia', 'asistencia.ver'],
  ['turnos', 'Horarios', 'turnos.ver'],
  ['personal', 'Personal', 'personal.ver'],
  ['usuarios', 'Usuarios', 'usuarios.gestionar'],
  ['roles', 'Roles y permisos', 'roles.gestionar'],
  ['actividad', 'Actividad', 'auditoria.ver'],
];

const VISTAS = {
  control: vistaControl,
  turnos: vistaTurnos,
  personal: vistaPersonal,
  usuarios: vistaUsuarios,
  roles: vistaRoles,
  actividad: vistaActividad,
  cuenta: vistaCuenta,
};

async function render() {
  clearInterval(S.timer);
  if (!S.token) return vistaLogin();
  try {
    S.user = await api('/auth/me'); // refresca permisos en cada cambio de pantalla
  } catch (e) {
    if (!S.user) return e.offline ? ($('#app').innerHTML = `<div class="cargando">${esc(e.message)}. Reintentá en unos segundos.</div>`) : undefined;
  }
  const items = NAV.filter(([, , p]) => can(p));
  let ruta = location.hash.replace(/^#\/?/, '');
  if (ruta !== 'cuenta' && !items.some(([r]) => r === ruta)) ruta = items[0]?.[0] || 'cuenta';

  const actual = ruta === 'cuenta' ? 'Mi contraseña' : items.find(([r]) => r === ruta)?.[1];
  $('#app').innerHTML = `
    <nav class="topnav">
      <button class="hamb" type="button" aria-label="Abrir menú" aria-expanded="false">
        <span class="hamb-ico">☰</span><span class="hamb-txt">${esc(actual)}</span>
      </button>
      <div class="brand">🛡️ ${esc(S.evento)}</div>
      <div class="tabs">${items.map(([r, l]) => `<a href="#/${r}" class="${r === ruta ? 'on' : ''}">${l}</a>`).join('')}</div>
      ${botonTema()}
      <div class="usr">
        <button class="usrbtn" type="button">${esc(S.user.nombre)} ▾</button>
        <div class="menu" hidden>
          <div class="mi-rol">${esc(S.user.usuario)} · ${esc(S.user.rol)}</div>
          <a href="#/cuenta">Cambiar mi contraseña</a>
          <button type="button" data-salir>Cerrar sesión</button>
        </div>
      </div>
    </nav>
    <div class="drawer-bg" hidden></div>
    <aside class="drawer" hidden aria-label="Menú">
      <div class="drawer-user"><b>${esc(S.user.nombre)}</b><small>${esc(S.user.usuario)} · ${esc(S.user.rol)}</small></div>
      ${items.map(([r, l]) => `<a href="#/${r}" class="${r === ruta ? 'on' : ''}">${l}</a>`).join('')}
      <hr>
      <a href="#/cuenta" class="${ruta === 'cuenta' ? 'on' : ''}">Cambiar mi contraseña</a>
      <button type="button" data-salir>Cerrar sesión</button>
    </aside>
    <main id="view"><div class="cargando">Cargando…</div></main>`;
  const menu = $('.menu');
  const drawer = $('.drawer');
  const fondo = $('.drawer-bg');
  const abrirDrawer = (abrir) => {
    drawer.hidden = fondo.hidden = !abrir;
    $('.hamb').setAttribute('aria-expanded', String(abrir));
  };
  $('.usrbtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  $('.hamb').onclick = () => abrirDrawer(drawer.hidden);
  fondo.onclick = () => abrirDrawer(false);
  drawer.onclick = (e) => e.target.closest('a') && abrirDrawer(false);
  document.onclick = () => (menu.hidden = true);
  $$('[data-salir]').forEach((b) => (b.onclick = salir));
  try {
    await VISTAS[ruta]();
  } catch (e) {
    $('#view').innerHTML = `<div class="page"><div class="vacio"><h3>No se pudo cargar</h3>${esc(e.message)}</div></div>`;
  }
}

function vistaLogin() {
  $('#app').innerHTML = `
    <div class="login-wrap">
      ${botonTema()}
      <form class="login" id="loginForm" novalidate>
        <div class="logo">🛡️</div>
        <h1>${esc(S.evento)}</h1>
        <p>Control de asistencia · Seguridad</p>
        <label class="field"><span>Usuario</span><input name="usuario" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password"></label>
        <p class="err"></p>
        <button class="btn primary big">Ingresar</button>
        <small>Acceso sólo para jefes y supervisores.</small>
      </form>
    </div>`;
  const f = $('#loginForm');
  f.usuario.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button', f);
    btn.disabled = true;
    $('.err', f).textContent = '';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { usuario: f.usuario.value, password: f.password.value } });
      S.token = r.token;
      S.user = r.user;
      store.set('asis_token', r.token);
      if (!location.hash) location.hash = '#/control'; // dispara render() por hashchange
      else render();
    } catch (ex) {
      $('.err', f).textContent = ex.message;
      btn.disabled = false;
    }
  };
}

// ═════════════════════════ Control de asistencia ═════════════════════════

function fechaPorDefecto(resumen, fechas) {
  const ahora = Date.now();
  // Si hay un turno en curso (o por empezar en las próximas 3 h), se muestra ese día,
  // así a las 2 AM se sigue viendo el turno noche que arrancó el día anterior.
  const activo = resumen.find((t) => {
    const { ini, fin } = rangoTurno(t);
    return ahora >= ini.getTime() - 3 * 36e5 && ahora <= fin.getTime() + 2 * 36e5;
  });
  if (activo) return activo.fecha;
  const h = hoy();
  if (fechas.includes(h)) return h;
  return fechas.find((f) => f > h) || fechas[fechas.length - 1];
}

async function vistaControl() {
  const v = $('#view');
  const resumen = await api('/turnos/resumen');
  const fechas = [...new Set(resumen.map((t) => t.fecha))];
  if (!fechas.length) {
    v.innerHTML = `<div class="page"><div class="vacio"><h3>Todavía no hay turnos cargados</h3>
      <p>Primero armá la plantilla de horarios y asigná el personal a cada turno.</p>
      ${can('turnos.gestionar') ? '<a class="btn primary" href="#/turnos">Ir a Horarios</a>' : 'Pedile a un jefe que cargue los horarios.'}</div></div>`;
    return;
  }
  const c = S.ctl;
  if (!fechas.includes(c.fecha)) c.fecha = fechaPorDefecto(resumen, fechas);
  c.firma = ''; // la vista es nueva: hay que pintar aunque los datos no hayan cambiado

  v.innerHTML = `
    <section class="ctl-head">
      <div class="ctl-top">
        <div>
          <h1>Control de Ingreso · ${esc(S.evento)}</h1>
          <div class="live" id="live"><span class="dot"></span><span id="liveTxt">Conectando…</span></div>
        </div>
        <div class="fecha-sel">
          <button class="ib" data-dia="-1" aria-label="Día anterior">‹</button>
          <select id="fechaSel">${fechas.map((f) => `<option value="${f}" ${f === c.fecha ? 'selected' : ''}>${fmtFecha(f)}</option>`).join('')}</select>
          <button class="ib" data-dia="1" aria-label="Día siguiente">›</button>
        </div>
      </div>
      <div class="stats" id="stats"></div>
      <div class="pills" id="pTurnos"></div>
      <div class="pills small" id="pEstados"></div>
      <input id="buscar" class="search" type="search" placeholder="Buscar por nombre o DNI…" autocomplete="off" value="${esc(c.q)}">
    </section>
    <section id="lista" class="lista"><div class="cargando">Cargando…</div></section>
    <div class="bottombar">
      ${can('turnos.gestionar') ? '<button class="btn green" id="bAgregar">+ Agregar</button>' : ''}
      ${can('reportes.exportar') ? '<button class="btn primary" id="bResumen">Copiar resumen</button><button class="btn" id="bCSV">Exportar CSV</button>' : ''}
    </div>`;

  const sel = $('#fechaSel');
  const actualizarFlechas = () => {
    const i = fechas.indexOf(c.fecha);
    $('[data-dia="-1"]').disabled = i <= 0;
    $('[data-dia="1"]').disabled = i >= fechas.length - 1;
  };
  const cambiarFecha = (f) => {
    c.fecha = f;
    c.turno = 'todos';
    c.data = null;
    c.firma = '';
    sel.value = f;
    actualizarFlechas();
    $('#lista').innerHTML = '<div class="cargando">Cargando…</div>';
    cargarAsistencia();
  };
  sel.onchange = () => cambiarFecha(sel.value);
  $$('[data-dia]').forEach((b) => (b.onclick = () => cambiarFecha(fechas[fechas.indexOf(c.fecha) + Number(b.dataset.dia)])));
  actualizarFlechas();

  $('#buscar').oninput = (e) => { c.q = e.target.value; pintarControl(); };
  $('#pTurnos').onclick = (e) => {
    const b = e.target.closest('[data-turno]');
    if (!b) return;
    c.turno = b.dataset.turno === 'todos' ? 'todos' : Number(b.dataset.turno);
    pintarControl();
  };
  $('#pEstados').onclick = (e) => {
    const b = e.target.closest('[data-estado]');
    if (!b) return;
    c.estado = b.dataset.estado;
    pintarControl();
  };
  $('#lista').onclick = onClickLista;
  $('#bAgregar') && ($('#bAgregar').onclick = modalAgregar);
  $('#bResumen') && ($('#bResumen').onclick = async () => { await copiar(textoResumen()); toast('Resumen copiado. Pegalo en WhatsApp.', { tipo: 'ok' }); });
  $('#bCSV') && ($('#bCSV').onclick = exportarCSV);

  await cargarAsistencia();
  S.timer = setInterval(() => {
    if (!document.hidden && !c.pendientes && !document.querySelector('.overlay')) cargarAsistencia(true);
  }, 5000);
}

async function cargarAsistencia(silencioso = false) {
  const c = S.ctl;
  const fecha = c.fecha;
  try {
    const d = await api('/asistencia?fecha=' + fecha);
    if (fecha !== c.fecha || c.pendientes) return; // cambió de día o hay una marca en vuelo
    const firma = JSON.stringify(d.turnos) + JSON.stringify(d.registros);
    const live = $('#live');
    if (live) {
      live.classList.remove('off');
      $('#liveTxt').textContent = `En vivo · actualizado ${new Date().toLocaleTimeString('es-AR', { hour12: false })}`;
    }
    if (firma === c.firma) return;
    c.firma = firma;
    c.data = d;
    pintarControl();
  } catch (e) {
    const live = $('#live');
    if (live) {
      live.classList.add('off');
      $('#liveTxt').textContent = 'Sin conexión · reintentando…';
    }
    if (!silencioso) toastError(e);
  }
}

function estadoDe(r) {
  return r.salida ? 'out' : r.entrada ? 'in' : 'pend';
}

function pintarControl() {
  const c = S.ctl;
  if (!c.data || !$('#lista')) return;
  const { turnos, registros } = c.data;
  const tmap = new Map(turnos.map((t) => [t.id, t]));
  if (c.turno !== 'todos' && !tmap.has(c.turno)) c.turno = 'todos';

  const delTurno = registros.filter((r) => c.turno === 'todos' || r.turno_id === c.turno);
  const ing = delTurno.filter((r) => r.entrada).length;
  const sal = delTurno.filter((r) => r.salida).length;
  const tot = delTurno.length;
  $('#stats').innerHTML = `
    <div class="stat ok"><b>${ing}</b><span>Ingresaron</span><small>${ing - sal} adentro</small></div>
    <div class="stat falta"><b>${tot - ing}</b><span>Faltan</span></div>
    <div class="stat"><b>${sal}</b><span>Salieron</span></div>
    <div class="stat"><b>${tot}</b><span>Total</span></div>`;

  $('#pTurnos').innerHTML =
    `<button class="pill ${c.turno === 'todos' ? 'on' : ''}" data-turno="todos">Todos</button>` +
    turnos
      .map((t) => `<button class="pill ${c.turno === t.id ? 'on' : ''}" data-turno="${t.id}">${esc(t.nombre)}<small>${t.hora_inicio}</small></button>`)
      .join('');
  const ESTADOS = [['todos', 'Ver todos'], ['pend', 'Pendientes'], ['in', 'Adentro'], ['out', 'Salieron']];
  $('#pEstados').innerHTML = ESTADOS.map(
    ([k, l]) => `<button class="pill ${c.estado === k ? 'on' : ''}" data-estado="${k}">${l}</button>`,
  ).join('');

  const q = norm(c.q).trim();
  const visibles = delTurno.filter(
    (r) =>
      (c.estado === 'todos' || estadoDe(r) === c.estado) &&
      (!q || norm(`${r.apellido} ${r.nombre} ${r.nombre} ${r.apellido}`).includes(q) || r.dni.includes(q.replace(/\D/g, '') || '§')),
  );

  if (!registros.length) {
    $('#lista').innerHTML = `<div class="vacio"><h3>No hay personal asignado este día</h3>
      ${can('turnos.gestionar') ? 'Asigná personal desde <a href="#/turnos">Horarios</a> o con “+ Agregar”.' : ''}</div>`;
    return;
  }
  let html = '';
  for (const t of turnos) {
    if (c.turno !== 'todos' && c.turno !== t.id) continue;
    const regsT = registros.filter((r) => r.turno_id === t.id);
    const vis = visibles.filter((r) => r.turno_id === t.id);
    if (!vis.length && (q || c.estado !== 'todos')) continue;
    html += `<div class="grp">${esc(t.nombre)} · ${regsT.filter((r) => r.entrada).length}/${regsT.length}
      <small>${t.hora_inicio}–${t.hora_fin}${t.puesto ? ' · ' + esc(t.puesto) : ''} · tolerancia ${t.tolerancia} min</small></div>`;
    html += vis.length ? vis.map((r) => filaHtml(r, t)).join('') : '<div class="vacio">Sin personal asignado a este turno.</div>';
  }
  $('#lista').innerHTML = html || '<div class="vacio">No hay resultados para ese filtro.</div>';
}

function filaHtml(r, t) {
  const { ini, fin } = rangoTurno(t);
  const limite = ini.getTime() + t.tolerancia * 60000;
  const estado = estadoDe(r);
  let badges = '';
  if (r.entrada) {
    const e = new Date(r.entrada).getTime();
    if (e > limite) badges += `<span class="b warn">Tarde +${dur(e - ini.getTime())}</span>`;
  } else if (Date.now() > fin.getTime()) {
    badges += '<span class="b bad">Ausente</span>';
  } else if (Date.now() > limite) {
    badges += `<span class="b bad">Demorado ${dur(Date.now() - ini.getTime())}</span>`;
  }
  if (r.salida && new Date(r.salida).getTime() < fin.getTime() - 5 * 60000) {
    badges += '<span class="b gray">Salió antes</span>';
  }
  const partes = [`DNI ${esc(r.dni)}`];
  if (r.puesto) partes.push(esc(r.puesto));
  if (r.entrada) partes.push(`Ingresó ${fmtHora(r.entrada)}`);
  if (r.salida) partes.push(`Salió ${fmtHora(r.salida)} (${dur(new Date(r.salida) - new Date(r.entrada))})`);
  else if (r.entrada) partes.push(`${dur(Date.now() - new Date(r.entrada))} adentro`);
  const marcar = can('asistencia.marcar');
  const etiqueta = estado === 'pend' ? 'Marcar entrada' : estado === 'in' ? 'Anular entrada' : 'Ver detalle';
  return `<div class="row ${estado}" data-id="${r.id}">
    <button class="chk" data-act="chk" ${marcar ? '' : 'disabled'} aria-label="${etiqueta} de ${esc(r.apellido)}" title="${etiqueta}">${r.entrada ? '✓' : ''}</button>
    <div class="info" data-act="det">
      <div class="nm"><span class="name">${esc(r.apellido)}, ${esc(r.nombre)}</span>
        <span class="tag" style="--c:${esc(t.color)}">${esc(t.nombre)}</span>${badges}</div>
      <div class="sub">${partes.join(' · ')}</div>
      ${r.observaciones ? `<div class="obs">📝 ${esc(r.observaciones)}</div>` : ''}
    </div>
    ${estado === 'in' && marcar ? '<button class="btn-out" data-act="salida">Salida</button>' : ''}
  </div>`;
}

const buscarReg = (id) => S.ctl.data?.registros.find((r) => r.id === id);
function reemplazarReg(nuevo) {
  const regs = S.ctl.data.registros;
  const i = regs.findIndex((r) => r.id === nuevo.id);
  if (i >= 0) regs[i] = nuevo;
  else regs.push(nuevo);
  S.ctl.firma = '';
}

// Marca optimista: se pinta al instante y se confirma con el servidor.
async function marcar(id, accion) {
  const c = S.ctl;
  const r = buscarReg(id);
  if (!r) return;
  const previo = { ...r };
  const ahora = new Date().toISOString();
  if (accion === 'entrada') Object.assign(r, { entrada: ahora, entrada_por: S.user.nombre, entrada_por_id: S.user.id });
  if (accion === 'salida') Object.assign(r, { salida: ahora, salida_por: S.user.nombre, salida_por_id: S.user.id });
  pintarControl();
  c.pendientes++;
  try {
    const nuevo = await api(`/asistencia/${id}/${accion}`, { method: 'POST' });
    reemplazarReg(nuevo);
    toast(`${accion === 'entrada' ? 'Entrada' : 'Salida'}: ${nuevo.apellido}, ${nuevo.nombre} · ${fmtHora(nuevo[accion])}`, {
      tipo: 'ok',
      accion: { label: 'Deshacer', fn: () => anular(id, accion, true) },
    });
  } catch (e) {
    if (e.data?.registro) reemplazarReg(e.data.registro);
    else Object.assign(r, previo);
    toastError(e);
  } finally {
    c.pendientes--;
    pintarControl();
  }
}

async function anular(id, campo, sinPreguntar = false) {
  const r = buscarReg(id);
  if (!r) return;
  if (!sinPreguntar && !(await confirmar(`¿Anular la ${campo} de ${r.apellido}, ${r.nombre} (${fmtHora(r[campo])})?`, { ok: `Anular ${campo}`, peligro: true }))) return;
  S.ctl.pendientes++;
  try {
    reemplazarReg(await api(`/asistencia/${id}/anular`, { method: 'POST', body: { campo } }));
    toast(`${campo === 'entrada' ? 'Entrada' : 'Salida'} anulada`);
  } catch (e) {
    toastError(e);
  } finally {
    S.ctl.pendientes--;
    pintarControl();
  }
}

function onClickLista(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.row').dataset.id);
  const r = buscarReg(id);
  if (!r) return;
  const act = btn.dataset.act;
  if (act === 'det') return modalDetalle(id);
  if (act === 'salida') return marcar(id, 'salida');
  if (act === 'chk') {
    const est = estadoDe(r);
    if (est === 'pend') return marcar(id, 'entrada');
    if (est === 'in') return anular(id, 'entrada');
    return modalDetalle(id);
  }
}

function modalDetalle(id) {
  const r = buscarReg(id);
  const t = S.ctl.data.turnos.find((x) => x.id === r.turno_id);
  const corregir = can('asistencia.corregir');
  const notas = can('asistencia.marcar') || corregir;
  const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const body = `
    <div class="det"><div class="big">${esc(r.apellido)}, ${esc(r.nombre)}</div>
      <div class="sub">DNI ${esc(r.dni)}${r.telefono ? ` · <a href="tel:${esc(r.telefono)}">${esc(r.telefono)}</a>` : ''}</div></div>
    <dl class="kv">
      ${kv('Turno', `${esc(t.nombre)} · ${fmtFecha(t.fecha)} · ${t.hora_inicio}–${t.hora_fin}`)}
      ${kv('Entrada', r.entrada ? `${fmtFechaHora(r.entrada)} <small class="contador">por ${esc(r.entrada_por || '—')}</small>` : '—')}
      ${kv('Salida', r.salida ? `${fmtFechaHora(r.salida)} <small class="contador">por ${esc(r.salida_por || '—')}</small>` : '—')}
      ${r.entrada && r.salida ? kv('Permanencia', dur(new Date(r.salida) - new Date(r.entrada))) : ''}
    </dl>
    <form class="form" novalidate>
      ${corregir ? campo({ name: 'entrada', label: 'Corregir entrada', type: 'datetime-local', value: aInputLocal(r.entrada), half: true }) : ''}
      ${corregir ? campo({ name: 'salida', label: 'Corregir salida', type: 'datetime-local', value: aInputLocal(r.salida), half: true }) : ''}
      ${corregir ? campo({ name: 'puesto', label: 'Puesto en este turno', value: r.puesto, placeholder: 'Ej: Puerta 1' }) : ''}
      ${notas ? campo({ name: 'observaciones', label: 'Observaciones', type: 'textarea', value: r.observaciones, rows: 2 }) : ''}
      ${corregir ? '<p class="hint">Dejá un horario vacío para borrarlo. Los cambios quedan registrados en Actividad.</p>' : ''}
      <p class="err"></p>
    </form>`;
  const actions = [{ label: 'Cerrar', cls: 'ghost', onClick: (c) => c() }];
  if (can('asistencia.marcar') && r.salida) actions.unshift({ label: 'Anular salida', cls: 'outline', onClick: (c) => { c(); anular(id, 'salida'); } });
  if (can('asistencia.marcar') && r.entrada && !r.salida) actions.unshift({ label: 'Anular entrada', cls: 'outline', onClick: (c) => { c(); anular(id, 'entrada'); } });
  if (notas) {
    actions.push({
      label: 'Guardar',
      cls: 'primary',
      onClick: async (close, b) => {
        const f = $('form', m.el);
        b.disabled = true;
        try {
          const nuevo = corregir
            ? await api(`/asistencia/${id}`, {
                method: 'PUT',
                body: {
                  entrada: desdeInputLocal(f.entrada.value),
                  salida: desdeInputLocal(f.salida.value),
                  puesto: f.puesto.value,
                  observaciones: f.observaciones.value,
                },
              })
            : await api(`/asistencia/${id}/observaciones`, { method: 'PUT', body: { observaciones: f.observaciones.value } });
          reemplazarReg(nuevo);
          pintarControl();
          close();
          toast('Guardado', { tipo: 'ok' });
        } catch (e) {
          $('.err', f).textContent = e.message;
          b.disabled = false;
        }
      },
    });
  }
  const m = modal({ title: 'Detalle de asistencia', body, actions });
}

function estadoTurno(t) {
  const { ini, fin } = rangoTurno(t);
  const ahora = Date.now();
  if (ahora < ini) {
    const dias = Math.floor((ini - ahora) / 864e5);
    return { txt: `Empieza en ${dias >= 1 ? `${dias} día${dias > 1 ? 's' : ''}` : dur(ini - ahora)}`, cls: 'gray' };
  }
  if (ahora <= fin) return { txt: `En curso · termina en ${dur(fin - ahora)}`, cls: 'ok' };
  return { txt: 'Finalizado', cls: 'bad' };
}

function infoTurnoHtml(t) {
  const { ini, fin } = rangoTurno(t);
  const est = estadoTurno(t);
  const cruza = t.hora_fin <= t.hora_inicio;
  return `<div class="tt"><span class="dot-c"></span>${esc(t.nombre)} <span class="b ${est.cls}">${est.txt}</span></div>
    <div class="ti">📅 <b>${fmtFecha(t.fecha)}</b></div>
    <div class="ti">🕘 ${t.hora_inicio} a ${t.hora_fin}${cruza ? ` (${fmtFechaCorta(fin.toLocaleDateString('sv-SE'))})` : ''} · ${dur(fin - ini)}</div>
    <div class="ti">📍 ${t.puesto ? esc(t.puesto) : 'Sin puesto definido'} · tolerancia ${t.tolerancia} min</div>
    <div class="ti">👥 ${t.asignados} asignados · ${t.ingresaron} ingresaron</div>`;
}

async function modalAgregar() {
  const c = S.ctl;
  const delDia = (c.data?.turnos || []).map((t) => {
    const regs = c.data.registros.filter((r) => r.turno_id === t.id);
    return { ...t, asignados: regs.length, ingresaron: regs.filter((r) => r.entrada).length };
  });
  let padron = [];
  let turnos = delDia;
  try {
    [padron, turnos] = await Promise.all([api('/personal'), can('turnos.ver') ? api('/turnos') : delDia]);
  } catch (e) {
    return toastError(e);
  }
  // Se ofrecen los turnos del día elegido y los que no terminaron hace más de 12 h.
  turnos = turnos.filter((t) => t.fecha === c.fecha || rangoTurno(t).fin.getTime() > Date.now() - 12 * 36e5);
  if (!turnos.length) return toast('No hay turnos disponibles');
  const porDni = new Map(padron.map((p) => [p.dni, p]));
  const alta = can('personal.gestionar');
  const turnoDef = c.turno !== 'todos' ? c.turno : (turnos.find((t) => t.fecha === c.fecha) || turnos[0]).id;
  formModal({
    title: 'Agregar personal al turno',
    submit: 'Agregar',
    fields: [
      {
        name: 'turno_id',
        label: 'Turno',
        type: 'select',
        value: turnoDef,
        options: turnos.map((t) => ({
          value: t.id,
          group: fmtFecha(t.fecha),
          label: `${t.nombre} · ${fmtFechaCorta(t.fecha)} · ${t.hora_inicio} a ${t.hora_fin}`,
        })),
      },
      { name: 'dni', label: 'DNI', required: true, attrs: 'inputmode="numeric" list="dlPadron" autocomplete="off"', hint: 'Escribí el DNI o buscá por apellido.' },
      { name: 'nombre', label: 'Nombre', half: true },
      { name: 'apellido', label: 'Apellido', half: true },
      { name: 'puesto', label: 'Puesto (opcional)', placeholder: 'Ej: Puerta 1' },
      ...(can('asistencia.marcar') ? [{ name: 'marcar', label: 'Marcar la entrada ahora', type: 'checkbox', value: true }] : []),
    ],
    extra: `<datalist id="dlPadron">${padron
      .filter((p) => p.activo)
      .map((p) => `<option value="${esc(p.dni)}">${esc(p.apellido)}, ${esc(p.nombre)}</option>`)
      .join('')}</datalist><p class="hint" id="estadoDni"></p>`,
    onMount: (form) => {
      form.turno_id.closest('.field').insertAdjacentHTML('afterend', '<div class="turno-info" id="turnoInfo"></div>');
      const pintarTurno = () => {
        const t = turnos.find((x) => x.id === Number(form.turno_id.value));
        const box = $('#turnoInfo');
        box.style.setProperty('--c', t.color);
        box.innerHTML = infoTurnoHtml(t);
      };
      form.turno_id.addEventListener('change', pintarTurno);
      pintarTurno();
      const sync = () => {
        const p = porDni.get(form.dni.value.replace(/\D/g, ''));
        const nuevos = [form.nombre, form.apellido];
        nuevos.forEach((el) => { el.closest('.field').hidden = !!p || !alta; });
        $('#estadoDni').textContent = p
          ? `✔ ${p.apellido}, ${p.nombre}${p.activo ? '' : ' (dado de baja)'}`
          : form.dni.value.length >= 6
            ? alta ? 'No está en el padrón: completá nombre y apellido para darlo de alta.' : 'Ese DNI no está en el padrón.'
            : '';
      };
      form.dni.addEventListener('input', sync);
      sync();
    },
    onSubmit: async (v, close) => {
      const reg = await api('/asistencia/agregar', { method: 'POST', body: v });
      close();
      toast(`${reg.apellido}, ${reg.nombre} agregado a ${reg.turno} (${fmtFechaCorta(reg.fecha)})`, { tipo: 'ok' });
      if (reg.fecha === c.fecha) {
        reemplazarReg(reg);
        if (v.marcar) await marcar(reg.id, 'entrada');
        else pintarControl();
      } else if (v.marcar) {
        // Turno de otro día: no está en pantalla, se marca directo en el servidor.
        await api(`/asistencia/${reg.id}/entrada`, { method: 'POST' }).catch(toastError);
      }
    },
  });
}

function textoResumen() {
  const c = S.ctl;
  const { turnos, registros } = c.data;
  const lineas = [`*Control de Ingreso · ${S.evento}* — ${fmtFecha(c.fecha)}`];
  const sel = turnos.filter((t) => c.turno === 'todos' || t.id === c.turno);
  const regs = registros.filter((r) => sel.some((t) => t.id === r.turno_id));
  const ing = regs.filter((r) => r.entrada).length;
  lineas.push(`Ingresaron ${ing}/${regs.length} · Faltan ${regs.length - ing} · Salieron ${regs.filter((r) => r.salida).length}`);
  for (const t of sel) {
    const rt = registros.filter((r) => r.turno_id === t.id);
    const { ini } = rangoTurno(t);
    const faltan = rt.filter((r) => !r.entrada);
    const tarde = rt.filter((r) => r.entrada && new Date(r.entrada) - ini > t.tolerancia * 60000);
    lineas.push('', `▸ *${t.nombre.toUpperCase()}* (${t.hora_inicio}–${t.hora_fin}) — ${rt.length - faltan.length}/${rt.length}`);
    if (faltan.length) lineas.push(`Faltan (${faltan.length}): ${faltan.map((r) => `${r.apellido} ${r.nombre}`).join(', ')}`);
    if (tarde.length) lineas.push(`Llegaron tarde (${tarde.length}): ${tarde.map((r) => `${r.apellido} ${r.nombre} (${fmtHora(r.entrada)})`).join(', ')}`);
  }
  return lineas.join('\n');
}

function exportarCSV() {
  const c = S.ctl;
  const { turnos, registros } = c.data;
  const tmap = new Map(turnos.map((t) => [t.id, t]));
  const filas = [['Fecha', 'Turno', 'Horario', 'Puesto', 'DNI', 'Apellido', 'Nombre', 'Entrada', 'Salida', 'Permanencia', 'Estado', 'Demora (min)', 'Marcó entrada', 'Marcó salida', 'Observaciones']];
  for (const r of registros) {
    const t = tmap.get(r.turno_id);
    if (c.turno !== 'todos' && t.id !== c.turno) continue;
    const { ini } = rangoTurno(t);
    const demora = r.entrada ? Math.round((new Date(r.entrada) - ini) / 60000) : '';
    filas.push([
      t.fecha, t.nombre, `${t.hora_inicio}-${t.hora_fin}`, r.puesto || t.puesto, r.dni, r.apellido, r.nombre,
      r.entrada ? fmtFechaHora(r.entrada) : '', r.salida ? fmtFechaHora(r.salida) : '',
      r.entrada && r.salida ? dur(new Date(r.salida) - new Date(r.entrada)) : '',
      { pend: 'Pendiente', in: 'Adentro', out: 'Salió' }[estadoDe(r)],
      demora === '' ? '' : Math.max(0, demora), r.entrada_por || '', r.salida_por || '', r.observaciones,
    ]);
  }
  descargarCSV(`asistencia-${c.fecha}.csv`, filas);
}

// ═════════════════════════ Horarios (plantilla de turnos) ═════════════════════════

async function vistaTurnos() {
  const v = $('#view');
  const gestionar = can('turnos.gestionar');
  const turnos = await api('/turnos');
  const porFecha = Map.groupBy ? Map.groupBy(turnos, (t) => t.fecha) : turnos.reduce((m, t) => m.set(t.fecha, [...(m.get(t.fecha) || []), t]), new Map());
  v.className = '';
  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Plantilla de horarios</h1>${gestionar ? '<button class="btn primary" id="nuevo">+ Nuevo turno</button>' : ''}</div>
    <p class="hint" style="margin-bottom:8px">Cada turno define día, horario y tolerancia. Asigná quiénes deben presentarse con “Personal”.</p>
    ${turnos.length ? '' : '<div class="vacio"><h3>No hay turnos</h3>Creá el primero con “+ Nuevo turno”.</div>'}
    ${[...porFecha]
      .map(
        ([fecha, ts]) => `<div class="dia">${fmtFecha(fecha)}</div><div class="cards">${ts
          .map(
            (t) => `<div class="card" data-id="${t.id}">
              <div class="colorbar" style="background:${esc(t.color)}"></div>
              <div class="main">
                <div class="t">${esc(t.nombre)} <span class="b gray">${t.hora_inicio} – ${t.hora_fin}${t.hora_fin <= t.hora_inicio ? ' (+1 día)' : ''}</span></div>
                <div class="d">${t.puesto ? esc(t.puesto) + ' · ' : ''}Tolerancia ${t.tolerancia} min · <b>${t.asignados}</b> asignados · ${t.ingresaron} ingresaron</div>
              </div>
              ${gestionar ? `<div class="acts">
                <button class="btn sm primary" data-act="personal">Personal</button>
                <button class="btn sm" data-act="editar">Editar</button>
                <button class="btn sm" data-act="duplicar">Duplicar</button>
                <button class="btn sm ghost" data-act="borrar">Eliminar</button></div>` : ''}
            </div>`,
          )
          .join('')}</div>`,
      )
      .join('')}
  </div>`;
  if (!gestionar) return;
  $('#nuevo').onclick = () => modalTurno();
  v.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const t = turnos.find((x) => x.id === Number(b.closest('.card').dataset.id));
    ({ personal: modalAsignar, editar: modalTurno, duplicar: modalDuplicar, borrar: borrarTurno })[b.dataset.act](t);
  };
}

function modalTurno(t) {
  const ultimo = store.get('ultima_fecha') || hoy();
  formModal({
    title: t ? 'Editar turno' : 'Nuevo turno',
    fields: [
      { name: 'nombre', label: 'Nombre del turno', value: t?.nombre, required: true, placeholder: 'Ej: Noche, Baile, Cena' },
      { name: 'fecha', label: 'Fecha', type: 'date', value: t?.fecha || ultimo, required: true },
      { name: 'hora_inicio', label: 'Hora de presentación', type: 'time', value: t?.hora_inicio || '20:00', required: true, half: true },
      { name: 'hora_fin', label: 'Hora de finalización', type: 'time', value: t?.hora_fin || '04:00', required: true, half: true, hint: 'Si es menor al inicio, termina al día siguiente.' },
      { name: 'puesto', label: 'Lugar / puesto', value: t?.puesto, placeholder: 'Ej: Acceso principal' },
      { name: 'tolerancia', label: 'Tolerancia (min)', type: 'number', value: t?.tolerancia ?? 10, half: true, attrs: 'min="0" max="240"' },
      { name: 'color', label: 'Color', type: 'color', value: t?.color || '#6366f1', half: true },
    ],
    onSubmit: async (v, close) => {
      await api(t ? `/turnos/${t.id}` : '/turnos', { method: t ? 'PUT' : 'POST', body: v });
      store.set('ultima_fecha', v.fecha);
      close();
      toast('Turno guardado', { tipo: 'ok' });
      vistaTurnos();
    },
  });
}

function modalDuplicar(t) {
  const sig = new Date(t.fecha + 'T12:00');
  sig.setDate(sig.getDate() + 1);
  formModal({
    title: `Duplicar “${t.nombre}”`,
    submit: 'Duplicar',
    fields: [
      { name: 'fecha', label: 'Nueva fecha', type: 'date', value: sig.toLocaleDateString('sv-SE'), required: true },
      { name: 'nombre', label: 'Nombre', value: t.nombre, required: true },
      { name: 'con_personal', label: `Copiar también el personal asignado (${t.asignados})`, type: 'checkbox', value: true },
    ],
    onSubmit: async (v, close) => {
      await api(`/turnos/${t.id}/duplicar`, { method: 'POST', body: v });
      close();
      toast('Turno duplicado', { tipo: 'ok' });
      vistaTurnos();
    },
  });
}

async function borrarTurno(t) {
  const extra = t.ingresaron ? ` Se perderán ${t.ingresaron} asistencias ya marcadas.` : '';
  if (!(await confirmar(`¿Eliminar el turno “${t.nombre}” del ${fmtFecha(t.fecha)}?${extra}`, { ok: 'Eliminar', peligro: true }))) return;
  try {
    await api(`/turnos/${t.id}`, { method: 'DELETE' });
    toast('Turno eliminado');
    vistaTurnos();
  } catch (e) {
    toastError(e);
  }
}

async function modalAsignar(t) {
  let padron, turno;
  try {
    [padron, turno] = await Promise.all([api('/personal'), api(`/turnos/${t.id}`)]);
  } catch (e) {
    return toastError(e);
  }
  const asignados = new Map(turno.asignaciones.map((a) => [a.personal_id, a]));
  const lista = padron.filter((p) => p.activo || asignados.has(p.id));
  const sel = new Set(asignados.keys());
  const m = modal({
    title: `Personal · ${t.nombre} (${fmtFecha(t.fecha)})`,
    wide: true,
    body: `
      <div class="asig-tools">
        <input class="search" type="search" placeholder="Filtrar por nombre o DNI…" id="asigQ">
        <button class="btn sm" id="asigTodos">Marcar visibles</button>
        <button class="btn sm" id="asigNinguno">Desmarcar visibles</button>
      </div>
      <p class="contador" id="asigCont"></p>
      <div class="asig-list" id="asigList">${
        lista.length
          ? lista
              .map((p) => {
                const a = asignados.get(p.id);
                const fijo = !!a?.entrada;
                return `<label data-q="${esc(norm(`${p.apellido} ${p.nombre} ${p.dni}`))}">
                  <input type="checkbox" value="${p.id}" ${sel.has(p.id) ? 'checked' : ''} ${fijo ? 'disabled' : ''}>
                  <span>${esc(p.apellido)}, ${esc(p.nombre)} ${fijo ? '<span class="b ok">ya ingresó</span>' : ''}${p.activo ? '' : '<span class="b gray">baja</span>'}</span>
                  <span class="dni">${esc(p.dni)}</span></label>`;
              })
              .join('')
          : '<div class="vacio">El padrón está vacío. Cargá personal primero.</div>'
      }</div>`,
    actions: [
      { label: 'Cancelar', cls: 'ghost', onClick: (c) => c() },
      {
        label: 'Guardar asignación',
        cls: 'primary',
        onClick: async (close, b) => {
          b.disabled = true;
          try {
            const r = await api(`/turnos/${t.id}/personal`, { method: 'PUT', body: { personal_ids: [...sel] } });
            close();
            toast(`Asignación guardada: +${r.agregados} / −${r.quitados}${r.conservados ? ` (${r.conservados} con entrada se conservaron)` : ''}`, { tipo: 'ok' });
            vistaTurnos();
          } catch (e) {
            toastError(e);
            b.disabled = false;
          }
        },
      },
    ],
  });
  const list = $('#asigList', m.el);
  const cont = () => ($('#asigCont', m.el).textContent = `${sel.size} seleccionados de ${lista.length}`);
  list.onchange = (e) => {
    const id = Number(e.target.value);
    e.target.checked ? sel.add(id) : sel.delete(id);
    cont();
  };
  $('#asigQ', m.el).oninput = (e) => {
    const q = norm(e.target.value);
    $$('label', list).forEach((l) => (l.hidden = !l.dataset.q.includes(q)));
  };
  const masivo = (marcar) => {
    $$('label:not([hidden]) input:not(:disabled)', list).forEach((i) => {
      i.checked = marcar;
      marcar ? sel.add(Number(i.value)) : sel.delete(Number(i.value));
    });
    cont();
  };
  $('#asigTodos', m.el).onclick = () => masivo(true);
  $('#asigNinguno', m.el).onclick = () => masivo(false);
  cont();
  $('#asigQ', m.el).focus();
}

// ═════════════════════════ Personal ═════════════════════════

async function vistaPersonal() {
  const v = $('#view');
  const gestionar = can('personal.gestionar');
  const padron = await api('/personal');
  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Personal de seguridad</h1>
      ${gestionar ? '<button class="btn" id="importar">Importar lista</button><button class="btn primary" id="nuevo">+ Nueva persona</button>' : ''}</div>
    <div class="toolbar">
      <input class="search" type="search" id="q" placeholder="Buscar por apellido, nombre o DNI…">
      <label class="chkline" style="width:auto"><input type="checkbox" id="verBajas"> Ver dados de baja</label>
    </div>
    <p class="contador" id="cont"></p>
    <div class="cards" id="lista"></div></div>`;
  const pintar = () => {
    const q = norm($('#q').value);
    const bajas = $('#verBajas').checked;
    const vis = padron.filter((p) => (bajas || p.activo) && norm(`${p.apellido} ${p.nombre} ${p.dni}`).includes(q));
    $('#cont').textContent = `${vis.length} de ${padron.filter((p) => p.activo).length} activos`;
    $('#lista').innerHTML =
      vis
        .map(
          (p) => `<div class="card ${p.activo ? '' : 'inactivo'}" data-id="${p.id}">
          <div class="main">
            <div class="t">${esc(p.apellido)}, ${esc(p.nombre)} ${p.activo ? '' : '<span class="b gray">Baja</span>'}</div>
            <div class="d">DNI ${esc(p.dni)}${p.telefono ? ' · ' + esc(p.telefono) : ''} · ${p.turnos} turno(s)${p.observaciones ? ' · ' + esc(p.observaciones) : ''}</div>
          </div>
          ${gestionar ? '<div class="acts"><button class="btn sm" data-act="editar">Editar</button><button class="btn sm ghost" data-act="borrar">Eliminar</button></div>' : ''}
        </div>`,
        )
        .join('') || '<div class="vacio">No hay personas para mostrar.</div>';
  };
  $('#q').oninput = pintar;
  $('#verBajas').onchange = pintar;
  pintar();
  if (!gestionar) return;
  $('#nuevo').onclick = () => modalPersona();
  $('#importar').onclick = modalImportar;
  $('#lista').onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const p = padron.find((x) => x.id === Number(b.closest('.card').dataset.id));
    if (b.dataset.act === 'editar') return modalPersona(p);
    if (!(await confirmar(`¿Eliminar a ${p.apellido}, ${p.nombre}? Se quitará de todos sus turnos.`, { ok: 'Eliminar', peligro: true }))) return;
    try {
      await api(`/personal/${p.id}`, { method: 'DELETE' });
      toast('Persona eliminada');
      vistaPersonal();
    } catch (ex) {
      toastError(ex);
    }
  };
}

function modalPersona(p) {
  formModal({
    title: p ? 'Editar persona' : 'Nueva persona',
    fields: [
      { name: 'dni', label: 'DNI', value: p?.dni, required: true, attrs: 'inputmode="numeric"' },
      { name: 'nombre', label: 'Nombre', value: p?.nombre, required: true, half: true },
      { name: 'apellido', label: 'Apellido', value: p?.apellido, required: true, half: true },
      { name: 'telefono', label: 'Teléfono', value: p?.telefono, attrs: 'inputmode="tel"' },
      { name: 'observaciones', label: 'Observaciones', type: 'textarea', value: p?.observaciones, rows: 2 },
      { name: 'activo', label: 'Activo', type: 'checkbox', value: p ? p.activo : true },
    ],
    onSubmit: async (v, close) => {
      await api(p ? `/personal/${p.id}` : '/personal', { method: p ? 'PUT' : 'POST', body: v });
      close();
      toast('Guardado', { tipo: 'ok' });
      vistaPersonal();
    },
  });
}

function modalImportar() {
  formModal({
    title: 'Importar personal',
    submit: 'Importar',
    wide: true,
    fields: [
      {
        name: 'texto',
        label: 'Pegá la lista (una persona por línea)',
        type: 'textarea',
        rows: 10,
        required: true,
        placeholder: 'DNI;Nombre;Apellido;Teléfono\n30123456;Juan;Pérez;2615551234\n40111222;Ana;López',
        hint: 'Columnas: DNI, Nombre, Apellido y Teléfono (opcional), separadas por ; , o tabulación. Podés copiar y pegar directo desde Excel. Si el DNI ya existe, se actualizan nombre y apellido.',
      },
    ],
    onSubmit: async (v, close, form) => {
      const r = await api('/personal/importar', { method: 'POST', body: v });
      toast(`${r.creados} nuevos · ${r.actualizados} actualizados${r.errores.length ? ` · ${r.errores.length} con error` : ''}`, { tipo: r.errores.length ? '' : 'ok' });
      if (r.errores.length) {
        vistaPersonal();
        throw new Error(r.errores.join('\n'));
      }
      close();
      vistaPersonal();
    },
  });
}

// ═════════════════════════ Usuarios ═════════════════════════

async function vistaUsuarios() {
  const v = $('#view');
  const [usuarios, roles] = await Promise.all([api('/usuarios'), api('/roles')]);
  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Usuarios</h1><button class="btn primary" id="nuevo">+ Nuevo usuario</button></div>
    <p class="hint" style="margin-bottom:12px">Sólo jefes y supervisores usan el sistema. El personal de seguridad no tiene acceso.</p>
    <div class="cards" id="lista">${usuarios
      .map(
        (u) => `<div class="card ${u.activo ? '' : 'inactivo'}" data-id="${u.id}">
        <div class="main"><div class="t">${esc(u.nombre)} <span class="chip">${esc(u.rol)}</span>
          ${u.activo ? '' : '<span class="b gray">Inactivo</span>'}${u.id === S.user.id ? '<span class="b ok">Vos</span>' : ''}</div>
          <div class="d">Usuario: ${esc(u.usuario)}</div></div>
        <div class="acts"><button class="btn sm" data-act="editar">Editar</button>
          ${u.id === S.user.id ? '' : '<button class="btn sm ghost" data-act="borrar">Eliminar</button>'}</div>
      </div>`,
      )
      .join('')}</div></div>`;
  const opcionesRol = roles
    .filter((r) => !r.sistema || can('roles.gestionar'))
    .map((r) => ({ value: r.id, label: r.nombre }));
  const form = (u) =>
    formModal({
      title: u ? 'Editar usuario' : 'Nuevo usuario',
      fields: [
        { name: 'usuario', label: 'Usuario (para ingresar)', value: u?.usuario, required: !u, readonly: !!u, attrs: 'autocapitalize="none" autocomplete="off"' },
        { name: 'nombre', label: 'Nombre y apellido', value: u?.nombre, required: true },
        { name: 'rol_id', label: 'Rol', type: 'select', value: u?.rol_id ?? roles.find((r) => r.nombre === 'Supervisor')?.id, options: opcionesRol },
        { name: 'password', label: u ? 'Nueva contraseña (vacío = no cambiar)' : 'Contraseña', type: 'password', required: !u, attrs: 'autocomplete="new-password"', hint: 'Mínimo 6 caracteres.' },
        { name: 'activo', label: 'Usuario activo (puede ingresar)', type: 'checkbox', value: u ? u.activo : true },
      ],
      onSubmit: async (val, close) => {
        await api(u ? `/usuarios/${u.id}` : '/usuarios', { method: u ? 'PUT' : 'POST', body: { ...val, rol_id: Number(val.rol_id) } });
        close();
        toast('Usuario guardado', { tipo: 'ok' });
        vistaUsuarios();
      },
    });
  $('#nuevo').onclick = () => form();
  $('#lista').onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const u = usuarios.find((x) => x.id === Number(b.closest('.card').dataset.id));
    if (b.dataset.act === 'editar') return form(u);
    if (!(await confirmar(`¿Eliminar el usuario “${u.usuario}”?`, { ok: 'Eliminar', peligro: true }))) return;
    try {
      await api(`/usuarios/${u.id}`, { method: 'DELETE' });
      toast('Usuario eliminado');
      vistaUsuarios();
    } catch (ex) {
      toastError(ex);
    }
  };
}

// ═════════════════════════ Roles y permisos ═════════════════════════

const GRUPOS = { asistencia: 'Asistencia', reportes: 'Reportes', turnos: 'Horarios', personal: 'Personal', usuarios: 'Usuarios', roles: 'Roles', auditoria: 'Actividad' };

async function vistaRoles() {
  const v = $('#view');
  const [roles, permisos] = await Promise.all([api('/roles'), api('/permisos')]);
  const desc = new Map(permisos.map((p) => [p.codigo, p.descripcion]));
  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Roles y permisos</h1><button class="btn primary" id="nuevo">+ Nuevo rol</button></div>
    <div class="cards" id="lista">${roles
      .map(
        (r) => `<div class="card" data-id="${r.id}">
        <div class="main"><div class="t">${esc(r.nombre)} ${r.sistema ? '<span class="b gray">Sistema</span>' : ''}
          <span class="contador">${r.usuarios} usuario(s)</span></div>
          <div class="d">${esc(r.descripcion)}</div>
          <div class="chips">${r.permisos.map((p) => `<span class="chip" title="${esc(p)}">${esc(desc.get(p) || p)}</span>`).join('')}</div></div>
        <div class="acts"><button class="btn sm" data-act="editar">Editar</button>
          ${r.sistema ? '' : '<button class="btn sm ghost" data-act="borrar">Eliminar</button>'}</div>
      </div>`,
      )
      .join('')}</div></div>`;

  const form = (r) => {
    const grupos = {};
    for (const p of permisos) (grupos[p.codigo.split('.')[0]] ??= []).push(p);
    const checks = Object.entries(grupos)
      .map(
        ([g, ps]) => `<div class="perm-grp"><h4>${GRUPOS[g] || g}</h4>${ps
          .map(
            (p) => `<label><input type="checkbox" name="perm" value="${p.codigo}" ${r?.sistema || r?.permisos.includes(p.codigo) ? 'checked' : ''} ${r?.sistema ? 'disabled' : ''}>
              <span>${esc(p.descripcion)}<br><code>${p.codigo}</code></span></label>`,
          )
          .join('')}</div>`,
      )
      .join('');
    formModal({
      title: r ? `Editar rol: ${r.nombre}` : 'Nuevo rol',
      wide: true,
      fields: [
        { name: 'nombre', label: 'Nombre', value: r?.nombre, required: true, readonly: !!r?.sistema },
        { name: 'descripcion', label: 'Descripción', value: r?.descripcion },
      ],
      extra: (r?.sistema ? '<p class="hint">El rol Administrador siempre tiene todos los permisos.</p>' : '') + checks,
      onSubmit: async (val, close, f) => {
        const body = { ...val, permisos: $$('input[name=perm]:checked', f).map((i) => i.value) };
        await api(r ? `/roles/${r.id}` : '/roles', { method: r ? 'PUT' : 'POST', body });
        close();
        toast('Rol guardado', { tipo: 'ok' });
        render(); // por si cambiaron mis propios permisos
      },
    });
  };
  $('#nuevo').onclick = () => form();
  $('#lista').onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const r = roles.find((x) => x.id === Number(b.closest('.card').dataset.id));
    if (b.dataset.act === 'editar') return form(r);
    if (!(await confirmar(`¿Eliminar el rol “${r.nombre}”?`, { ok: 'Eliminar', peligro: true }))) return;
    try {
      await api(`/roles/${r.id}`, { method: 'DELETE' });
      toast('Rol eliminado');
      vistaRoles();
    } catch (ex) {
      toastError(ex);
    }
  };
}

// ═════════════════════════ Actividad y cuenta ═════════════════════════

async function vistaActividad() {
  const v = $('#view');
  const filas = await api('/auditoria');
  v.innerHTML = `<div class="page">
    <div class="page-head"><h1>Registro de actividad</h1><button class="btn" id="csv">Exportar CSV</button></div>
    <div class="toolbar"><input class="search" type="search" id="q" placeholder="Filtrar por usuario, acción o persona…"></div>
    <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th></tr></thead><tbody id="tb"></tbody></table></div>
    <p class="hint" style="margin-top:8px">Se muestran los últimos 1000 movimientos.</p></div>`;
  const pintar = () => {
    const q = norm($('#q').value);
    $('#tb').innerHTML = filas
      .filter((f) => norm(`${f.usuario} ${f.accion} ${f.detalle}`).includes(q))
      .map((f) => `<tr><td class="nw">${fmtFechaHora(f.fecha)}</td><td class="nw">${esc(f.usuario || '—')}</td><td class="nw">${esc(f.accion)}</td><td>${esc(f.detalle)}</td></tr>`)
      .join('');
  };
  $('#q').oninput = pintar;
  $('#csv').onclick = () =>
    descargarCSV('actividad.csv', [['Fecha', 'Usuario', 'Acción', 'Detalle'], ...filas.map((f) => [fmtFechaHora(f.fecha), f.usuario, f.accion, f.detalle])]);
  pintar();
}

function vistaCuenta() {
  $('#view').innerHTML = `<div class="page" style="max-width:480px">
    <div class="page-head"><h1>Mi contraseña</h1></div>
    <form class="form card" id="fp" novalidate style="display:flex">
      ${campo({ name: 'actual', label: 'Contraseña actual', type: 'password', attrs: 'autocomplete="current-password"' })}
      ${campo({ name: 'nueva', label: 'Contraseña nueva', type: 'password', attrs: 'autocomplete="new-password"', hint: 'Mínimo 6 caracteres.' })}
      ${campo({ name: 'repetir', label: 'Repetir contraseña nueva', type: 'password', attrs: 'autocomplete="new-password"' })}
      <p class="err"></p>
      <button class="btn primary">Cambiar contraseña</button>
    </form></div>`;
  const f = $('#fp');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.err', f);
    err.textContent = '';
    if (f.nueva.value !== f.repetir.value) return (err.textContent = 'Las contraseñas nuevas no coinciden');
    try {
      await api('/auth/password', { method: 'POST', body: { actual: f.actual.value, nueva: f.nueva.value } });
      f.reset();
      toast('Contraseña actualizada', { tipo: 'ok' });
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
}

// ═════════════════════════ Arranque ═════════════════════════

window.addEventListener('hashchange', render);
fetch('/api/config')
  .then((r) => r.json())
  .then((c) => { S.evento = c.evento || S.evento; document.title = `Asistencia · ${S.evento}`; })
  .catch(() => {})
  .finally(render);
