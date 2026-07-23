/* app.js — camada de UI do Ponto.
 * Consome exclusivamente window.PontoStorage, window.PontoCalc e window.PontoRelatorios.
 * Não implementa storage nem cálculos de jornada. Sem módulos ES, sem framework.
 */
(function () {
  'use strict';

  var TZ = 'America/Sao_Paulo';

  /* ================================================================
   * Datas seguras (sempre componentes locais de America/Sao_Paulo)
   * ================================================================ */
  var fmtISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  var fmtRelogio = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  var fmtDataLonga = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  function hojeISO() { return fmtISO.format(new Date()); }

  function partes(iso) {
    var p = iso.split('-');
    return { ano: +p[0], mes: +p[1], dia: +p[2] };
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function montarISO(ano, mes, dia) { return ano + '-' + pad2(mes) + '-' + pad2(dia); }

  // Aritmética de calendário determinística (UTC puro, sem fuso do aparelho).
  function utcDe(iso) {
    var p = partes(iso);
    return new Date(Date.UTC(p.ano, p.mes - 1, p.dia));
  }
  function diasNoMes(ano, mes) { return new Date(Date.UTC(ano, mes, 0)).getUTCDate(); }
  function nomeMes(ano, mes) {
    var s = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'long', year: 'numeric' })
      .format(new Date(Date.UTC(ano, mes - 1, 1)));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function diaSemanaCurto(iso) {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'short' })
      .format(utcDe(iso)).replace('.', '');
  }
  function dataBR(iso) {
    var p = partes(iso);
    return pad2(p.dia) + '/' + pad2(p.mes) + '/' + p.ano;
  }
  function dataLongaBR(iso) {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
    }).format(utcDe(iso));
  }

  /* ================================================================
   * Utilidades de UI
   * ================================================================ */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg, tipo) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'visivel' + (tipo ? ' ' + tipo : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 3200);
  }

  function vibrar(padrao) {
    if (navigator.vibrate) { try { navigator.vibrate(padrao); } catch (e) { /* ignora */ } }
  }

  function msgErro(err) {
    var m = (err && (err.message || err.toString())) || 'Erro desconhecido';
    if (/401|Bad credentials/i.test(m)) return 'Token inválido ou expirado. Verifique em Config.';
    if (/404|Not Found/i.test(m)) return 'Repositório não encontrado. Confira owner/repo e as permissões do token.';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Sem conexão. Os dados locais continuam disponíveis.';
    return m;
  }

  function classeSaldo(min) { return min > 0 ? 'pos' : (min < 0 ? 'neg' : 'neutro'); }

  function rotuloBatida(i) {
    var fixos = ['Entrada', 'Almoço', 'Retorno', 'Saída'];
    if (i < 4) return fixos[i];
    return (i % 2 === 0) ? 'Entrada' : 'Saída';
  }

  var NOMES_TIPO = {
    normal: 'Normal', feriado: 'Feriado', ferias: 'Férias',
    atestado: 'Atestado', abono: 'Abono'
  };

  function contratoOK() {
    return window.PontoStorage && window.PontoCalc && window.PontoRelatorios;
  }

  function diaVazio() { return { batidas: [], obs: '', tipo: 'normal' }; }

  /* ================================================================
   * Estado da aplicação
   * ================================================================ */
  var estado = {
    aba: 'hoje',
    isoHoje: hojeISO(),
    diaHoje: null, // último dia renderizado na tela Hoje (p/ tempo em aberto)
    hist: { ano: 0, mes: 0, dias: null },
    rel: { resumo: null, inicioISO: null, fimISO: null },
    modal: { dataISO: null, diaOriginal: null }
  };

  function getNome() { try { return localStorage.getItem('ponto.nome') || ''; } catch (e) { return ''; } }
  function setNome(v) { try { localStorage.setItem('ponto.nome', v); } catch (e) { /* ignora */ } }

  function configAtual() {
    try { return window.PontoStorage.getConfig() || null; } catch (e) { return null; }
  }
  function configPronta(cfg) {
    return !!(cfg && (cfg.demo || (cfg.owner && cfg.repo && cfg.token)));
  }

  function atualizarSelo() {
    var selo = $('selo-estado');
    var cfg = configAtual();
    if (cfg && cfg.demo) { selo.textContent = 'DEMO'; selo.className = 'selo selo-demo'; }
    else if (configPronta(cfg)) { selo.textContent = 'GITHUB'; selo.className = 'selo selo-online'; }
    else { selo.textContent = 'SEM CONFIG'; selo.className = 'selo selo-off'; }
  }

  /* ================================================================
   * Navegação por abas
   * ================================================================ */
  function mostrarAba(nome) {
    estado.aba = nome;
    var telas = document.querySelectorAll('.tela');
    for (var i = 0; i < telas.length; i++) telas[i].classList.remove('ativa');
    $('tela-' + nome).classList.add('ativa');

    var abas = document.querySelectorAll('.aba');
    for (var j = 0; j < abas.length; j++) {
      abas[j].classList.toggle('ativa', abas[j].getAttribute('data-aba') === nome);
    }
    window.scrollTo(0, 0);

    if (nome === 'hoje') carregarHoje();
    if (nome === 'historico') carregarHistorico();
    if (nome === 'relatorios') atualizarPrevia();
    if (nome === 'config') preencherConfig();
  }

  /* ================================================================
   * TELA HOJE
   * ================================================================ */
  var relogioEl, dataHojeEl;
  var ultimoMinutoTick = '';

  function tickRelogio() {
    var s = fmtRelogio.format(new Date()); // "HH:MM:SS"
    relogioEl.innerHTML = esc(s.slice(0, 5)) + '<small>:' + esc(s.slice(6, 8)) + '</small>';
    var iso = hojeISO();
    if (iso !== estado.isoHoje) { // virou o dia
      estado.isoHoje = iso;
      renderDataHoje();
      if (estado.aba === 'hoje') carregarHoje();
      return;
    }
    // A cada minuto, re-renderiza a tela Hoje se houver período em aberto,
    // para o KPI "Trabalhado" acompanhar o tempo correndo.
    var minutoAtual = s.slice(0, 5);
    if (minutoAtual !== ultimoMinutoTick) {
      ultimoMinutoTick = minutoAtual;
      if (estado.aba === 'hoje' && estado.diaHoje &&
          (estado.diaHoje.batidas || []).length % 2 === 1) {
        renderHoje(estado.diaHoje);
      }
    }
  }

  // "HH:MM" -> minutos desde 00:00 (só para o tempo em aberto da tela Hoje).
  function hhmmMin(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function renderDataHoje() {
    dataHojeEl.textContent = fmtDataLonga.format(new Date());
  }

  function renderHoje(dia) {
    var lista = $('lista-batidas-hoje');
    var vazio = $('hoje-vazio');
    var avisos = $('hoje-avisos');
    dia = dia || diaVazio();
    estado.diaHoje = dia;

    var r = window.PontoCalc.calcularDia(dia, estado.isoHoje);

    // Período em aberto HOJE: soma o tempo correndo (última batida -> agora)
    // ao total exibido, como o aviso promete. Atualizado a cada minuto.
    var totalExibido = r.totalMin;
    if (r.aberto && dia.batidas && dia.batidas.length) {
      var ultimaMin = hhmmMin(dia.batidas[dia.batidas.length - 1]);
      var agoraMin = hhmmMin(window.PontoStorage.horaAgoraHHMM());
      if (ultimaMin !== null && agoraMin !== null && agoraMin > ultimaMin) {
        totalExibido = r.totalMin + (agoraMin - ultimaMin);
      }
    }
    var saldoExibido = totalExibido - r.metaMin;

    $('kpi-total').textContent = window.PontoCalc.fmtMin(totalExibido);
    $('kpi-meta').textContent = window.PontoCalc.fmtMin(r.metaMin);
    var saldoEl = $('kpi-saldo');
    saldoEl.textContent = window.PontoCalc.fmtSaldo(saldoExibido);
    saldoEl.className = 'valor ' + classeSaldo(saldoExibido);

    avisos.innerHTML = '';
    if (dia.tipo && dia.tipo !== 'normal') {
      avisos.innerHTML += '<div class="aviso aviso-azul"><span>Dia marcado como <b>' +
        esc(NOMES_TIPO[dia.tipo] || dia.tipo) + '</b> — meta zerada; tudo trabalhado conta como extra.</span></div>';
    }
    if (r.aberto) {
      avisos.innerHTML += '<div class="aviso aviso-azul"><span>Período em aberto — o total inclui o tempo correndo até agora.</span></div>';
    }

    var b = dia.batidas || [];
    lista.innerHTML = '';
    if (!b.length) {
      vazio.classList.remove('oculto');
    } else {
      vazio.classList.add('oculto');
      var html = '';
      for (var i = 0; i < b.length; i++) {
        var saida = (i % 2 === 1);
        html += '<li><span class="ponto-bola' + (saida ? ' saida' : '') + '"></span>' +
          '<span class="batida-rotulo">' + esc(rotuloBatida(i)) + '</span>' +
          '<span class="batida-hora">' + esc(b[i]) + '</span></li>';
      }
      lista.innerHTML = html;
    }
  }

  function carregarHoje() {
    if (!contratoOK()) return;
    var cfg = configAtual();
    $('aviso-sem-config').classList.toggle('oculto', configPronta(cfg));
    if (!configPronta(cfg)) { renderHoje(null); return; }

    var p = partes(estado.isoHoje);
    $('hoje-carregando').classList.remove('oculto');
    window.PontoStorage.carregarMes(p.ano, p.mes).then(function (res) {
      renderHoje((res && res.dias && res.dias[estado.isoHoje]) || null);
    }).catch(function (err) {
      toast(msgErro(err), 'erro');
      renderHoje(null);
    }).then(function () {
      $('hoje-carregando').classList.add('oculto');
    });
  }

  /* Sincroniza pendências offline (na inicialização e quando a rede volta). */
  function sincronizarPendencias() {
    if (!contratoOK() || !window.PontoStorage.sincronizarPendentes) return;
    window.PontoStorage.sincronizarPendentes().then(function (r) {
      if (r && r.enviadas > 0) {
        toast(r.enviadas + ' registro(s) pendente(s) sincronizado(s) com o GitHub.', 'ok');
        if (estado.aba === 'hoje') carregarHoje();
        if (estado.aba === 'historico') carregarHistorico();
      }
    }).catch(function () { /* tenta de novo no próximo evento */ });
  }

  function baterPonto() {
    var btn = $('btn-bater');
    var cfg = configAtual();
    if (!configPronta(cfg)) {
      toast('Configure o app antes de bater ponto.', 'erro');
      mostrarAba('config');
      return;
    }
    btn.disabled = true;
    window.PontoStorage.baterPonto().then(function (dia) {
      vibrar([80, 40, 80]);
      btn.classList.add('sucesso');
      setTimeout(function () { btn.classList.remove('sucesso'); }, 1200);
      var b = (dia && dia.batidas) || [];
      var ultima = b.length ? b[b.length - 1] : '';
      toast('Ponto registrado' + (ultima ? ' às ' + ultima : '') + '.', 'ok');
      renderHoje(dia);
    }).catch(function (err) {
      vibrar(250);
      toast(msgErro(err), 'erro');
    }).then(function () {
      btn.disabled = false;
    });
  }

  /* ================================================================
   * TELA HISTÓRICO
   * ================================================================ */
  function carregarHistorico() {
    if (!contratoOK()) return;
    var h = estado.hist;
    $('rotulo-mes').textContent = nomeMes(h.ano, h.mes);
    $('hist-erro').classList.add('oculto');
    $('hist-carregando').classList.remove('oculto');
    $('lista-dias').innerHTML = '';

    window.PontoStorage.carregarMes(h.ano, h.mes).then(function (res) {
      h.dias = (res && res.dias) || {};
      renderHistorico();
    }).catch(function (err) {
      h.dias = {};
      var e = $('hist-erro');
      e.innerHTML = '<span>' + esc(msgErro(err)) + '</span>';
      e.classList.remove('oculto');
      renderHistorico();
    }).then(function () {
      $('hist-carregando').classList.add('oculto');
    });
  }

  function renderHistorico() {
    var h = estado.hist;
    var hoje = partes(estado.isoHoje);
    var totalDias = diasNoMes(h.ano, h.mes);

    // Último dia exibido: hoje (mês corrente), todos (mês passado), só com dados (futuro).
    var ehMesAtual = (h.ano === hoje.ano && h.mes === hoje.mes);
    var ehFuturo = (h.ano > hoje.ano) || (h.ano === hoje.ano && h.mes > hoje.mes);
    var ultimo = ehMesAtual ? hoje.dia : totalDias;

    var inicioISO = montarISO(h.ano, h.mes, 1);
    var fimISO = montarISO(h.ano, h.mes, ehFuturo ? totalDias : ultimo);
    var resumo = window.PontoCalc.resumoPeriodo(h.dias, inicioISO, fimISO);
    $('hist-total').textContent = window.PontoCalc.fmtMin(resumo.totalMin);
    $('hist-meta').textContent = window.PontoCalc.fmtMin(resumo.metaMin);
    var se = $('hist-saldo');
    se.textContent = window.PontoCalc.fmtSaldo(resumo.saldoMin);
    se.className = 'valor ' + classeSaldo(resumo.saldoMin);

    var html = '';
    var qtd = 0;
    for (var d = (ehFuturo ? totalDias : ultimo); d >= 1; d--) {
      var iso = montarISO(h.ano, h.mes, d);
      var dia = h.dias[iso];
      if (ehFuturo && !dia) continue; // mês futuro: só dias com dados
      var temDado = !!(dia && ((dia.batidas && dia.batidas.length) || dia.obs || (dia.tipo && dia.tipo !== 'normal')));
      var r = window.PontoCalc.calcularDia(dia || diaVazio(), iso);
      var batidasTxt = (dia && dia.batidas && dia.batidas.length) ? dia.batidas.join(' · ') : 'Sem batidas';

      var etiquetas = '';
      if (dia && dia.tipo && dia.tipo !== 'normal') {
        etiquetas += '<span class="etiqueta et-tipo">' + esc(NOMES_TIPO[dia.tipo] || dia.tipo) + '</span>';
      }
      if (r.aberto && iso === estado.isoHoje) etiquetas += '<span class="etiqueta et-aberto">Em andamento</span>';
      else if (r.inconsistente) etiquetas += '<span class="etiqueta et-alerta">Inconsistente</span>';

      var mostraSaldo = temDado || r.metaMin > 0;
      html += '<button class="linha-dia" type="button" data-dia="' + iso + '">' +
        '<span class="dia-num"><span class="n">' + d + '</span><span class="s">' + esc(diaSemanaCurto(iso)) + '</span></span>' +
        '<span class="dia-info">' +
          '<span class="dia-total">' + window.PontoCalc.fmtMin(r.totalMin) + ' trabalhadas' + etiquetas + '</span><br>' +
          '<span class="dia-batidas">' + esc(batidasTxt) + '</span>' +
        '</span>' +
        '<span class="dia-saldo ' + classeSaldo(r.saldoMin) + '">' +
          (mostraSaldo ? window.PontoCalc.fmtSaldo(r.saldoMin) : '—') +
        '</span></button>';
      qtd++;
    }
    if (!qtd) html = '<div class="vazio">Nenhum registro neste mês.</div>';
    $('lista-dias').innerHTML = html;

    var linhas = document.querySelectorAll('#lista-dias .linha-dia');
    for (var i = 0; i < linhas.length; i++) {
      linhas[i].addEventListener('click', function () {
        abrirModalDia(this.getAttribute('data-dia'));
      });
    }
  }

  function mudarMes(delta) {
    var h = estado.hist;
    var m = h.mes + delta;
    if (m < 1) { m = 12; h.ano--; }
    if (m > 12) { m = 1; h.ano++; }
    h.mes = m;
    carregarHistorico();
  }

  /* ================================================================
   * MODAL DE EDIÇÃO DE DIA
   * ================================================================ */
  function abrirModalDia(dataISO) {
    var dia = estado.hist.dias[dataISO] || diaVazio();
    estado.modal.dataISO = dataISO;
    estado.modal.diaOriginal = dia;

    $('modal-titulo').textContent = dataLongaBR(dataISO);
    $('modal-tipo').value = (dia.tipo && NOMES_TIPO[dia.tipo]) ? dia.tipo : 'normal';
    $('modal-obs').value = dia.obs || '';

    var cont = $('modal-batidas');
    cont.innerHTML = '';
    var b = dia.batidas || [];
    for (var i = 0; i < b.length; i++) adicionarLinhaBatida(b[i]);
    if (!b.length) {
      cont.innerHTML = '<div class="vazio" id="modal-sem-batidas">Sem batidas neste dia.</div>';
    }
    $('modal-dia').classList.remove('oculto');
  }

  function adicionarLinhaBatida(valor) {
    var cont = $('modal-batidas');
    var vazio = $('modal-sem-batidas');
    if (vazio) vazio.remove();
    var linha = document.createElement('div');
    linha.className = 'edicao-batida';
    linha.innerHTML =
      '<input type="time" step="60" value="' + esc(valor || '') + '">' +
      '<button class="btn-remover" type="button" aria-label="Remover batida">✕</button>';
    linha.querySelector('.btn-remover').addEventListener('click', function () { linha.remove(); });
    cont.appendChild(linha);
  }

  function fecharModal() { $('modal-dia').classList.add('oculto'); }

  function salvarModal() {
    var inputs = document.querySelectorAll('#modal-batidas input[type="time"]');
    var batidas = [];
    for (var i = 0; i < inputs.length; i++) {
      var v = (inputs[i].value || '').slice(0, 5);
      if (!v) continue;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
        toast('Horário inválido: ' + v, 'erro');
        return;
      }
      batidas.push(v);
    }
    batidas.sort();

    var original = estado.modal.diaOriginal || diaVazio();
    var dia = {};
    for (var k in original) { if (Object.prototype.hasOwnProperty.call(original, k)) dia[k] = original[k]; }
    dia.batidas = batidas;
    dia.obs = $('modal-obs').value.trim();
    dia.tipo = $('modal-tipo').value;

    var btn = $('btn-modal-salvar');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    window.PontoStorage.salvarDia(estado.modal.dataISO, dia).then(function () {
      toast('Dia ' + dataBR(estado.modal.dataISO) + ' salvo.', 'ok');
      vibrar(60);
      fecharModal();
      carregarHistorico();
      if (estado.modal.dataISO === estado.isoHoje) carregarHoje();
    }).catch(function (err) {
      toast(msgErro(err), 'erro');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Salvar dia';
    });
  }

  /* ================================================================
   * TELA RELATÓRIOS
   * ================================================================ */
  function periodoDoRelatorio(tipo, refISO) {
    if (tipo === 'diario') return { inicioISO: refISO, fimISO: refISO };
    if (tipo === 'semanal') {
      var s = window.PontoCalc.semanaDe(refISO);
      return { inicioISO: s.inicioISO, fimISO: s.fimISO };
    }
    var p = partes(refISO);
    return {
      inicioISO: montarISO(p.ano, p.mes, 1),
      fimISO: montarISO(p.ano, p.mes, diasNoMes(p.ano, p.mes))
    };
  }

  function carregarFaixa(inicioISO, fimISO) {
    // Carrega 1 ou 2 meses (semana pode cruzar a virada) e mescla os mapas de dias.
    var a = partes(inicioISO), b = partes(fimISO);
    var pedidos = [window.PontoStorage.carregarMes(a.ano, a.mes)];
    if (a.ano !== b.ano || a.mes !== b.mes) {
      pedidos.push(window.PontoStorage.carregarMes(b.ano, b.mes));
    }
    return Promise.all(pedidos).then(function (res) {
      var dias = {};
      for (var i = 0; i < res.length; i++) {
        var m = (res[i] && res[i].dias) || {};
        for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) dias[k] = m[k]; }
      }
      return dias;
    });
  }

  function atualizarPrevia() {
    if (!contratoOK()) return;
    var tipo = $('rel-tipo').value;
    var refISO = $('rel-data').value || estado.isoHoje;
    var faixa = periodoDoRelatorio(tipo, refISO);

    $('rel-erro').classList.add('oculto');
    $('rel-vazio').classList.add('oculto');
    $('rel-tabela-envolt').classList.add('oculto');
    $('rel-carregando').classList.remove('oculto');
    $('btn-pdf').disabled = true;
    $('btn-excel').disabled = true;
    $('rel-periodo').textContent = '— ' + dataBR(faixa.inicioISO) +
      (faixa.fimISO !== faixa.inicioISO ? ' a ' + dataBR(faixa.fimISO) : '');

    var cfg = configAtual();
    var pronto = configPronta(cfg)
      ? carregarFaixa(faixa.inicioISO, faixa.fimISO)
      : Promise.resolve({});

    pronto.then(function (dias) {
      var resumo = window.PontoCalc.resumoPeriodo(dias, faixa.inicioISO, faixa.fimISO);
      estado.rel = { resumo: resumo, inicioISO: faixa.inicioISO, fimISO: faixa.fimISO, tipo: tipo };
      renderPrevia(resumo);
      $('btn-pdf').disabled = false;
      $('btn-excel').disabled = false;
    }).catch(function (err) {
      var e = $('rel-erro');
      e.innerHTML = '<span>' + esc(msgErro(err)) + '</span>';
      e.classList.remove('oculto');
    }).then(function () {
      $('rel-carregando').classList.add('oculto');
    });
  }

  function renderPrevia(resumo) {
    var porDia = (resumo && resumo.porDia) || [];
    if (!porDia.length) {
      $('rel-vazio').classList.remove('oculto');
      return;
    }
    var html = '<thead><tr><th>Dia</th><th>Batidas</th><th>Total</th><th>Meta</th><th>Saldo</th></tr></thead><tbody>';
    for (var i = 0; i < porDia.length; i++) {
      var d = porDia[i];
      var iso = d.dataISO || d.data || d.dia;
      var batidas = (d.batidas && d.batidas.length) ? d.batidas.join(' ') : '—';
      html += '<tr><td>' + esc(iso ? (dataBR(iso) + ' (' + diaSemanaCurto(iso) + ')') : '—') + '</td>' +
        '<td>' + esc(batidas) + '</td>' +
        '<td>' + window.PontoCalc.fmtMin(d.totalMin || 0) + '</td>' +
        '<td>' + window.PontoCalc.fmtMin(d.metaMin || 0) + '</td>' +
        '<td class="' + classeSaldo(d.saldoMin || 0) + '">' + window.PontoCalc.fmtSaldo(d.saldoMin || 0) + '</td></tr>';
    }
    html += '</tbody><tfoot><tr><td colspan="2">Totais (' + resumo.diasTrabalhados +
      ' dia(s) trabalhado(s), ' + resumo.diasUteis + ' útil(eis))</td>' +
      '<td>' + window.PontoCalc.fmtMin(resumo.totalMin) + '</td>' +
      '<td>' + window.PontoCalc.fmtMin(resumo.metaMin) + '</td>' +
      '<td class="' + classeSaldo(resumo.saldoMin) + '">' + window.PontoCalc.fmtSaldo(resumo.saldoMin) + '</td></tr></tfoot>';
    $('rel-tabela').innerHTML = html;
    $('rel-tabela-envolt').classList.remove('oculto');
  }

  function metaRelatorio() {
    return {
      nome: getNome() || 'Colaborador',
      inicioISO: estado.rel.inicioISO,
      fimISO: estado.rel.fimISO,
      periodo: dataBR(estado.rel.inicioISO) +
        (estado.rel.fimISO !== estado.rel.inicioISO ? ' a ' + dataBR(estado.rel.fimISO) : '')
    };
  }

  function baixarRelatorio(formato) {
    if (!estado.rel.resumo) { toast('Gere a prévia antes de baixar.', 'erro'); return; }
    try {
      if (formato === 'pdf') window.PontoRelatorios.gerarPDF(estado.rel.tipo, estado.rel.resumo, metaRelatorio());
      else window.PontoRelatorios.gerarExcel(estado.rel.tipo, estado.rel.resumo, metaRelatorio());
      toast('Download iniciado.', 'ok');
    } catch (err) {
      toast(msgErro(err), 'erro');
    }
  }

  /* ================================================================
   * TELA CONFIG
   * ================================================================ */
  function preencherConfig() {
    var cfg = configAtual() || {};
    $('cfg-nome').value = getNome();
    $('cfg-owner').value = cfg.owner || 'TarcioDiniz';
    $('cfg-repo').value = cfg.repo || 'clockin-data';
    $('cfg-token').value = cfg.token || '';
    $('cfg-demo').checked = !!cfg.demo;
    $('config-boasvindas').classList.toggle('oculto', configPronta(cfg));
  }

  function salvarConfig() {
    setNome($('cfg-nome').value.trim());
    var nova = {
      owner: $('cfg-owner').value.trim(),
      repo: $('cfg-repo').value.trim(),
      token: $('cfg-token').value.trim(),
      demo: $('cfg-demo').checked
    };
    try {
      window.PontoStorage.setConfig(nova);
    } catch (err) {
      toast(msgErro(err), 'erro');
      return;
    }
    atualizarSelo();
    $('config-boasvindas').classList.toggle('oculto', configPronta(nova));
    if (configPronta(nova)) {
      toast('Configurações salvas.', 'ok');
      vibrar(60);
      mostrarAba('hoje');
    } else {
      toast('Salvo, mas falta owner, repo e token — ou ative o modo demo.', 'erro');
    }
  }

  function testarConexao() {
    // Salva primeiro para testar exatamente o que está nos campos.
    setNome($('cfg-nome').value.trim());
    var nova = {
      owner: $('cfg-owner').value.trim(),
      repo: $('cfg-repo').value.trim(),
      token: $('cfg-token').value.trim(),
      demo: $('cfg-demo').checked
    };
    if (!nova.demo && (!nova.owner || !nova.repo || !nova.token)) {
      toast('Preencha owner, repo e token para testar.', 'erro');
      return;
    }
    try { window.PontoStorage.setConfig(nova); } catch (e) { toast(msgErro(e), 'erro'); return; }
    atualizarSelo();

    var btn = $('btn-testar');
    btn.disabled = true;
    btn.textContent = 'Testando…';
    var p = partes(estado.isoHoje);
    window.PontoStorage.carregarMes(p.ano, p.mes).then(function () {
      toast(nova.demo ? 'Modo demo funcionando.' : 'Conexão com o GitHub OK.', 'ok');
      vibrar(60);
    }).catch(function (err) {
      toast(msgErro(err), 'erro');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Testar conexão';
    });
  }

  /* ================================================================
   * Inicialização
   * ================================================================ */
  function iniciar() {
    relogioEl = $('relogio');
    dataHojeEl = $('data-hoje');

    if (!contratoOK()) {
      document.body.insertAdjacentHTML('afterbegin',
        '<div class="aviso aviso-vermelho" style="margin:12px">Erro: js/storage.js ou js/reports.js não carregou. Recarregue a página.</div>');
      return;
    }

    // Estado inicial de datas
    estado.isoHoje = hojeISO();
    var p = partes(estado.isoHoje);
    estado.hist.ano = p.ano;
    estado.hist.mes = p.mes;
    $('rel-data').value = estado.isoHoje;

    renderDataHoje();
    tickRelogio();
    setInterval(tickRelogio, 1000);

    // Eventos — navegação
    var abas = document.querySelectorAll('.aba');
    for (var i = 0; i < abas.length; i++) {
      abas[i].addEventListener('click', function () {
        mostrarAba(this.getAttribute('data-aba'));
      });
    }

    // Hoje
    $('btn-bater').addEventListener('click', baterPonto);

    // Histórico
    $('btn-mes-ant').addEventListener('click', function () { mudarMes(-1); });
    $('btn-mes-prox').addEventListener('click', function () { mudarMes(1); });

    // Modal
    $('btn-modal-fechar').addEventListener('click', fecharModal);
    $('btn-add-batida').addEventListener('click', function () { adicionarLinhaBatida(''); });
    $('btn-modal-salvar').addEventListener('click', salvarModal);
    $('modal-dia').addEventListener('click', function (ev) {
      if (ev.target === this) fecharModal();
    });

    // Relatórios
    $('rel-tipo').addEventListener('change', atualizarPrevia);
    $('rel-data').addEventListener('change', atualizarPrevia);
    $('btn-pdf').addEventListener('click', function () { baixarRelatorio('pdf'); });
    $('btn-excel').addEventListener('click', function () { baixarRelatorio('excel'); });

    // Config
    $('btn-salvar-config').addEventListener('click', salvarConfig);
    $('btn-testar').addEventListener('click', testarConexao);

    atualizarSelo();

    // Sincronização de pendências offline: ao abrir e quando a rede voltar.
    sincronizarPendencias();
    window.addEventListener('online', sincronizarPendencias);

    // Primeira visita: sem config utilizável -> abre Config com explicação.
    var cfg = configAtual();
    if (!configPronta(cfg)) {
      mostrarAba('config');
      $('config-boasvindas').classList.remove('oculto');
    } else {
      mostrarAba('hoje');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
