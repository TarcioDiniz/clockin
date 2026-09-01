/* app.js — camada de UI do Ponto.
 * Consome exclusivamente window.PontoStorage, window.PontoCalc e window.PontoRelatorios.
 * Não implementa storage nem cálculos de jornada. Sem módulos ES, sem framework.
 */
(function () {
  'use strict';

  var TZ = 'America/Sao_Paulo';
  // Versão exibida em Config. Subir junto com o ?v= do index.html e o CACHE do sw.js.
  var APP_VERSAO = 'v7';
  // Regra do usuário: intervalo (almoço) mínimo de 1h. Apenas UI — o motor
  // de cálculo (PontoCalc) não é afetado.
  var INTERVALO_MINIMO_MIN = 60;

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
    mesHoje: null, // mapa de dias do mês corrente (p/ o card "Meta do mês")
    fin: { ano: 0, meses: [], carregado: false, mesAberto: null },
    rel: { resumo: null, inicioISO: null, fimISO: null },
    modal: { dataISO: null, diaOriginal: null }
  };

  // Cache em memória dos meses já baixados (chave "AAAA-MM") — evita refazer
  // 12 requisições ao GitHub a cada troca de aba/ano.
  var cacheMeses = {};

  /* ---------------- contrato financeiro ---------------- */

  // Lê o contrato salvo (ou o padrão) e o instala no motor de cálculo, para
  // que KPIs e relatórios usem a MESMA jornada diária.
  function aplicarContrato() {
    var salvo = null;
    try { salvo = window.PontoStorage.getContrato(); } catch (e) { salvo = null; }
    return window.PontoCalc.setContrato(salvo || window.PontoCalc.CONTRATO_PADRAO);
  }

  // Sincroniza o contrato com o contrato.json do repositório em dois casos:
  //  1) aparelho novo, sem contrato local  -> adota o remoto inteiro;
  //  2) contrato local antigo, sem o campo "inicio" (gravado por uma versão
  //     anterior do app) -> mantém tudo o que já estava aqui e só aprende a
  //     data de início. Best effort e silencioso: nunca bloqueia o início.
  function herdarContratoRemoto() {
    var local = null;
    try { local = window.PontoStorage.getContrato(); } catch (e) { local = null; }
    if (!window.PontoStorage.baixarContrato) return;
    if (local && typeof local.inicio === 'string') return;   // já está em dia

    window.PontoStorage.baixarContrato().then(function (remoto) {
      if (!remoto) return;
      var novo = remoto;
      var msg = 'Contrato carregado do seu repositório.';

      if (local) {
        novo = {};
        for (var k in local) {
          if (Object.prototype.hasOwnProperty.call(local, k)) novo[k] = local[k];
        }
        novo.inicio = remoto.inicio || '';
        if (!novo.inicio) return;                            // nada novo a aprender
        msg = 'Início do contrato sincronizado: ' +
          window.PontoCalc.formatarDataBR(novo.inicio) + '.';
      }

      try { window.PontoStorage.setContrato(novo); } catch (e) { /* segue em memória */ }
      window.PontoCalc.setContrato(novo);
      estado.fin.carregado = false;
      try { preencherContrato(); } catch (e) { /* Config ainda não montada */ }
      try { atualizarAvisoContrato(); } catch (e) { /* idem */ }
      renderHoje(estado.diaHoje);
      if (estado.aba === 'financeiro') { try { carregarFin(); } catch (e) { /* ignora */ } }
      toast(msg);
    });
  }

  // Limpa caches do Service Worker e recarrega do zero. Não toca em
  // localStorage: registros, contrato e configurações continuam intactos.
  function forcarAtualizacao() {
    var passos = [];
    if (window.caches && caches.keys) {
      passos.push(caches.keys().then(function (chaves) {
        return Promise.all(chaves.map(function (c) { return caches.delete(c); }));
      }));
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      passos.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }));
    }
    Promise.all(passos).catch(function () { /* segue mesmo assim */ }).then(function () {
      var base = location.href.split('#')[0].split('?')[0];
      location.replace(base + '?atualizado=' + new Date().getTime());
    });
  }
  function contratoAtual() { return window.PontoCalc.getContrato(); }

  /* ---------------- feriados ---------------- */

  // Respostas do usuário sobre feriados regionais + região escolhida.
  // { regiao, decisoes: { "AAAA-MM-DD": "folga"|"trabalho" } }
  var feriadosCfg = { regiao: '', decisoes: {} };
  var filaFeriados = [];          // feriados aguardando resposta no modal

  function regiaoAtual() {
    return window.PontoFeriados.normalizarRegiao(feriadosCfg.regiao);
  }

  // Recalcula o mapa de folgas e o entrega ao motor de cálculo. Cobre todos os
  // anos que as telas podem mostrar (hoje, Histórico e Financeiro), com uma
  // folga de um ano para cada lado.
  function aplicarFeriados() {
    var F = window.PontoFeriados;
    var anos = [partes(estado.isoHoje || hojeISO()).ano];
    if (estado.fin && estado.fin.ano) anos.push(estado.fin.ano);
    if (estado.hist && estado.hist.ano) anos.push(estado.hist.ano);
    var min = Math.min.apply(null, anos) - 1;
    var max = Math.max.apply(null, anos) + 1;
    var mapa = F.folgas(min + '-01-01', max + '-12-31', regiaoAtual(), feriadosCfg.decisoes);
    window.PontoCalc.setFeriados(mapa);
    return mapa;
  }

  function carregarFeriadosLocais() {
    try { feriadosCfg = window.PontoStorage.getFeriados(); }
    catch (e) { feriadosCfg = { regiao: '', decisoes: {} }; }
    aplicarFeriados();
  }

  // Herda feriados.json do repositório (aparelho novo, ou respostas dadas em
  // outro aparelho). Best effort — nunca bloqueia o app.
  function herdarFeriadosRemotos() {
    if (!window.PontoStorage.baixarFeriados) return;
    window.PontoStorage.baixarFeriados().then(function (remoto) {
      if (!remoto) return;
      var mudou = remoto.regiao !== feriadosCfg.regiao;
      // As respostas locais valem mais que as remotas: quem respondeu aqui
      // acabou de responder. O remoto só acrescenta datas que faltavam.
      for (var k in remoto.decisoes) {
        if (!Object.prototype.hasOwnProperty.call(remoto.decisoes, k)) continue;
        if (!feriadosCfg.decisoes[k]) { feriadosCfg.decisoes[k] = remoto.decisoes[k]; mudou = true; }
      }
      if (!feriadosCfg.regiao && remoto.regiao) feriadosCfg.regiao = remoto.regiao;
      if (!mudou) return;
      aplicarFeriados();
      estado.fin.carregado = false;
      renderHoje(estado.diaHoje);
      atualizarBannerFeriados();
      try { renderListaFeriados(); } catch (e) { /* Config ainda não montada */ }
    });
  }

  function salvarFeriados() {
    aplicarFeriados();
    estado.fin.carregado = false;
    return window.PontoStorage.setFeriados({
      regiao: regiaoAtual(), decisoes: feriadosCfg.decisoes
    });
  }

  /**
   * Feriados regionais sem resposta, do início do contrato (ou de 1 ano atrás)
   * até hoje. Só o passado: não faz sentido perguntar sobre dezembro em março.
   */
  function feriadosPendentes() {
    var hoje = estado.isoHoje || hojeISO();
    var c = contratoAtual();
    var de = c.inicio || ((partes(hoje).ano - 1) + '-01-01');
    return window.PontoFeriados.pendentes(de, hoje, regiaoAtual(), feriadosCfg.decisoes);
  }

  function atualizarBannerFeriados() {
    var el = $('banner-feriados');
    if (!el) return;
    var lista = feriadosPendentes();
    if (!lista.length || !configPronta(configAtual())) {
      el.classList.add('oculto');
      return;
    }
    var n = lista.length;
    el.innerHTML = '<span>' +
      (n === 1
        ? 'Teve um feriado em <b>' + esc(window.PontoCalc.formatarDataBR(lista[0].data)) + '</b> (' +
          esc(lista[0].nome) + '). Seu trabalho liberou esse dia?'
        : n + ' feriados esperando sua confirmação. Toque para responder.') +
      '</span>';
    el.classList.remove('oculto');
  }

  function abrirFilaFeriados() {
    filaFeriados = feriadosPendentes();
    proximoFeriado();
  }

  function proximoFeriado() {
    if (!filaFeriados.length) {
      $('modal-feriado').classList.add('oculto');
      atualizarBannerFeriados();
      renderHoje(estado.diaHoje);
      try { renderListaFeriados(); } catch (e) { /* ignora */ }
      return;
    }
    var f = filaFeriados[0];
    $('feriado-data').textContent = window.PontoCalc.formatarDataBR(f.data);
    $('feriado-nome').textContent = f.nome;
    $('feriado-escopo').textContent = f.rotulo;
    $('feriado-contador').textContent = filaFeriados.length > 1
      ? ('1 de ' + filaFeriados.length + ' pendentes') : '';
    $('modal-feriado').classList.remove('oculto');
  }

  function responderFeriado(resposta) {
    var f = filaFeriados.shift();
    if (!f) { proximoFeriado(); return; }
    feriadosCfg.decisoes[f.data] = resposta;
    salvarFeriados().then(function (r) {
      if (r && r.local && !r.remoto && !modoDemo()) {
        toast('Salvo neste aparelho — o GitHub será atualizado depois.', 'aviso');
      }
    });
    proximoFeriado();
  }

  /* Lista de feriados na Config (permite mudar de ideia depois) */
  function anoFeriadosSelecionado() {
    var v = +($('cfg-fer-ano') && $('cfg-fer-ano').value);
    return v || partes(estado.isoHoje || hojeISO()).ano;
  }

  function preencherAnosFeriados() {
    var sel = $('cfg-fer-ano');
    if (!sel || sel.options.length) return;
    var atual = partes(estado.isoHoje || hojeISO()).ano;
    var html = '';
    for (var a = atual - 1; a <= atual + 1; a++) {
      html += '<option value="' + a + '"' + (a === atual ? ' selected' : '') + '>' + a + '</option>';
    }
    sel.innerHTML = html;
  }

  // Rótulos curtos: na lista da Config a linha é estreita e o nome do feriado
  // já ocupa duas linhas.
  var ROTULO_CURTO = {
    nacional: 'nacional', estadual: 'estadual · PB',
    municipal: 'municipal · Campina Grande', facultativo: 'ponto facultativo'
  };

  function renderListaFeriados() {
    var el = $('cfg-fer-lista');
    if (!el) return;
    preencherAnosFeriados();
    var ano = anoFeriadosSelecionado();
    var lista = window.PontoFeriados.situacaoDoAno(ano, regiaoAtual(), feriadosCfg.decisoes);
    if (!lista.length) { el.innerHTML = '<div class="vazio">Nenhum feriado neste ano.</div>'; return; }

    var html = '';
    for (var i = 0; i < lista.length; i++) {
      var f = lista[i];
      var dm = f.data.slice(8, 10) + '/' + f.data.slice(5, 7);
      var classe = 'fer-linha' + (f.automatico ? ' auto' : (f.pendente ? ' pendente' : ''));
      html += '<div class="' + classe + '">' +
        '<div class="fl-data">' + dm + '</div>' +
        '<div class="fl-txt"><div class="fl-nome">' + esc(f.nome) + '</div>' +
        '<div class="fl-tipo">' + esc(ROTULO_CURTO[f.escopo] || f.rotulo) + '</div></div>';
      if (f.automatico) {
        html += '<div class="fl-fixo">folga fixa</div>';
      } else {
        html += '<select data-feriado="' + f.data + '">' +
          '<option value=""' + (f.decisao ? '' : ' selected') + '>Perguntar</option>' +
          '<option value="folga"' + (f.decisao === 'folga' ? ' selected' : '') + '>Foi folga</option>' +
          '<option value="trabalho"' + (f.decisao === 'trabalho' ? ' selected' : '') + '>Teve expediente</option>' +
          '</select>';
      }
      html += '</div>';
    }
    el.innerHTML = html;

    var selects = el.querySelectorAll('select[data-feriado]');
    for (var j = 0; j < selects.length; j++) {
      selects[j].addEventListener('change', function () {
        var data = this.getAttribute('data-feriado');
        if (this.value) feriadosCfg.decisoes[data] = this.value;
        else delete feriadosCfg.decisoes[data];
        salvarFeriados();
        renderHoje(estado.diaHoje);
        atualizarBannerFeriados();
        renderListaFeriados();
        atualizarAvisoContrato();
      });
    }
  }

  function getNome() { try { return localStorage.getItem('ponto.nome') || ''; } catch (e) { return ''; } }
  function setNome(v) { try { localStorage.setItem('ponto.nome', v); } catch (e) { /* ignora */ } }

  function configAtual() {
    try { return window.PontoStorage.getConfig() || null; } catch (e) { return null; }
  }
  function configPronta(cfg) {
    return !!(cfg && (cfg.demo || (cfg.owner && cfg.repo && cfg.token)));
  }
  function modoDemo() {
    var cfg = configAtual();
    return !!(cfg && cfg.demo);
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
    if (nome === 'financeiro') carregarFin();
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
    // A cada minuto, re-renderiza a tela Hoje se houver período em aberto
    // (KPI "Trabalhado" correndo) OU intervalo em andamento (2 batidas —
    // card do intervalo mínimo de 1h).
    var minutoAtual = s.slice(0, 5);
    if (minutoAtual !== ultimoMinutoTick) {
      ultimoMinutoTick = minutoAtual;
      if (estado.aba === 'hoje' && estado.diaHoje) {
        var nb = (estado.diaHoje.batidas || []).length;
        if (nb % 2 === 1 || nb === 2) renderHoje(estado.diaHoje);
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

  /* Minutos decorridos desde "HH:MM" até agora (fuso SP). null se inválido
   * ou se "agora" for antes da hora dada (ex.: virada de dia). */
  function minutosDesde(hhmm) {
    var ini = hhmmMin(hhmm);
    var agora = hhmmMin(window.PontoStorage.horaAgoraHHMM());
    if (ini === null || agora === null || agora < ini) return null;
    return agora - ini;
  }

  /* ---------- Card "Intervalo em andamento" (2 batidas = saiu p/ almoço) */
  function renderIntervalo(dia) {
    var card = $('card-intervalo');
    var b = (dia && dia.batidas) || [];
    if (b.length !== 2) { card.classList.add('oculto'); return; }
    var dec = minutosDesde(b[1]);
    if (dec === null) { card.classList.add('oculto'); return; }

    $('int-tempo').textContent = window.PontoCalc.fmtMin(dec);
    if (dec < INTERVALO_MINIMO_MIN) {
      card.classList.remove('completo');
      $('int-titulo').textContent = 'Intervalo em andamento';
      $('int-msg').textContent = 'Faltam ' + (INTERVALO_MINIMO_MIN - dec) +
        ' min para completar o intervalo mínimo de 1h.';
    } else {
      card.classList.add('completo');
      $('int-titulo').textContent = 'Intervalo mínimo cumprido ✓';
      $('int-msg').textContent = 'Você já pode registrar o retorno.';
    }
    card.classList.remove('oculto');
  }

  /* ---------- Banner de pendências de sincronização (tela Hoje) */
  function atualizarBannerPendentes() {
    var el = $('banner-pendentes');
    if (!el || !window.PontoStorage.contarPendentes) return;
    var cfg = configAtual();
    var n = window.PontoStorage.contarPendentes();
    if (!cfg || cfg.demo || n === 0) { el.classList.add('oculto'); return; }
    var erro = window.PontoStorage.ultimoErroSync ? window.PontoStorage.ultimoErroSync() : null;
    var motivo = (erro && erro.mensagem) ? erro.mensagem : 'aguardando conexão com o GitHub';
    el.innerHTML = '<span>⚠</span><span>' + n +
      ' registro(s) no celular aguardando envio ao GitHub — Motivo: ' + esc(motivo) +
      ' <b><u>Toque para reenviar.</u></b></span>';
    el.classList.remove('oculto');
  }

  var reenviando = false;
  function reenviarPendentes() {
    if (reenviando || !window.PontoStorage.sincronizarPendentes) return;
    reenviando = true;
    var el = $('banner-pendentes');
    el.innerHTML = '<span class="girador"></span><span>Reenviando registros ao GitHub…</span>';
    window.PontoStorage.sincronizarPendentes().then(function (r) {
      reenviando = false;
      r = r || { enviadas: 0, restantes: 0 };
      if (r.restantes === 0 && r.enviadas > 0) {
        toast(r.enviadas + ' registro(s) enviado(s) ao GitHub com sucesso.', 'ok');
        vibrar(60);
        carregarHoje();
      } else if (r.enviadas > 0) {
        toast(r.enviadas + ' enviado(s), ' + r.restantes + ' ainda pendente(s).', 'erro');
        atualizarBannerPendentes();
      } else {
        var erro = window.PontoStorage.ultimoErroSync ? window.PontoStorage.ultimoErroSync() : null;
        toast('Falha ao reenviar: ' + ((erro && erro.mensagem) || 'erro desconhecido'), 'erro');
        atualizarBannerPendentes();
      }
    }).catch(function () {
      reenviando = false;
      atualizarBannerPendentes();
    });
  }

  /* ================================================================
   * Card "Meta do mês" (aba Hoje)
   * ================================================================ */

  // Minutos do período ainda aberto de hoje (última batida ímpar -> agora).
  function minutosEmAberto() {
    var dia = estado.diaHoje;
    if (!dia || !dia.batidas || dia.batidas.length % 2 === 0) return 0;
    var ultima = hhmmMin(dia.batidas[dia.batidas.length - 1]);
    var agora = hhmmMin(window.PontoStorage.horaAgoraHHMM());
    if (ultima === null || agora === null || agora <= ultima) return 0;
    return agora - ultima;
  }

  function renderMetaMes() {
    var C = window.PontoCalc;
    var c = contratoAtual();
    var p = partes(estado.isoHoje);
    var iniISO = montarISO(p.ano, p.mes, 1);
    var fimISO = montarISO(p.ano, p.mes, diasNoMes(p.ano, p.mes));

    var resumo = C.resumoPeriodo(estado.mesHoje || {}, iniISO, fimISO, estado.isoHoje);
    var totalMin = resumo.totalMin + minutosEmAberto();
    var baseMin = C.baseMesMin(p.ano, p.mes, c);
    var f = C.calcularValores(totalMin, baseMin, c);

    $('meta-mes-rotulo').textContent = '— ' + nomeMes(p.ano, p.mes);
    $('meta-feito').textContent = C.fmtMin(totalMin);
    $('meta-alvo').textContent = 'de ' + C.fmtMin(baseMin);

    var pct = Math.round(f.progresso * 100);
    $('meta-pct').textContent = pct + '%';
    var barra = $('meta-barra');
    barra.style.width = Math.max(0, Math.min(100, pct)) + '%';
    barra.classList.toggle('completa', totalMin >= baseMin && baseMin > 0);

    var restante = $('meta-restante');
    if (f.extraMin > 0) {
      restante.textContent = '+' + C.fmtMin(f.extraMin) + ' extras';
      restante.className = 'pos';
    } else {
      restante.textContent = C.fmtMin(f.faltaMin) + ' a fazer';
      restante.className = 'neutro';
    }

    $('meta-valor-hora').textContent = C.fmtBRL(f.valorHora);
    $('meta-total').textContent = C.fmtBRL(f.total);

    var obs;
    if (f.extraMin > 0) {
      obs = 'Meta do mês batida. ' + C.fmtHorasDec(f.extraMin) + ' de extra = ' +
        C.fmtBRL(f.valorExtra) + ' acima do valor fixo de ' + C.fmtBRL(f.valorBase) + '.';
    } else if (f.desconto > 0) {
      obs = 'Faltam ' + C.fmtHorasDec(f.faltaMin) + ' para a meta — desconto previsto de ' +
        C.fmtBRL(f.desconto) + '.';
    } else {
      obs = 'Faltam ' + C.fmtHorasDec(f.faltaMin) + ' para fechar a meta do mês. ' +
        'Só o que passar disso vira hora extra.';
    }
    $('meta-obs').textContent = obs;
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
    } else if (r.feriado) {
      avisos.innerHTML += '<div class="aviso aviso-azul"><span>Hoje é <b>' +
        esc(r.feriado) + '</b> — meta zerada. Tudo o que você bater hoje entra como hora extra.</span></div>';
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

    // Intervalo mínimo (1h) + lembrete + banner de pendências
    renderIntervalo(dia);
    if (b.length === 2) agendarLembrete(dia); else cancelarLembrete();
    atualizarBannerPendentes();
    atualizarBannerFeriados();
    renderMetaMes();
  }

  function carregarHoje() {
    if (!contratoOK()) return;
    var cfg = configAtual();
    $('aviso-sem-config').classList.toggle('oculto', configPronta(cfg));
    if (!configPronta(cfg)) { renderHoje(null); return; }

    var p = partes(estado.isoHoje);
    $('hoje-carregando').classList.remove('oculto');
    window.PontoStorage.carregarMes(p.ano, p.mes).then(function (res) {
      // guarda o mês inteiro: o card "Meta do mês" precisa de todos os dias
      estado.mesHoje = (res && res.dias) || {};
      cacheMeses[chaveMes(p.ano, p.mes)] = estado.mesHoje;
      estado.fin.carregado = false;
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
        cacheMeses = {};
        estado.fin.carregado = false;
        if (estado.aba === 'hoje') carregarHoje();
        if (estado.aba === 'historico') carregarHistorico();
      }
      atualizarBannerPendentes();
    }).catch(function () { /* tenta de novo no próximo evento */ });
  }

  function baterPonto(confirmado) {
    var btn = $('btn-bater');
    var cfg = configAtual();
    if (!configPronta(cfg)) {
      toast('Configure o app antes de bater ponto.', 'erro');
      mostrarAba('config');
      return;
    }

    // 3ª batida com intervalo < 1h: pede confirmação (não bloqueia).
    if (!confirmado) {
      var atual = (estado.diaHoje && estado.diaHoje.batidas) || [];
      if (atual.length === 2) {
        var dec = minutosDesde(atual[1]);
        if (dec !== null && dec < INTERVALO_MINIMO_MIN) {
          $('modal-intervalo-texto').textContent =
            'Seu intervalo tem só ' + dec + ' min — o mínimo é 1h. Registrar retorno mesmo assim?';
          $('modal-intervalo').classList.remove('oculto');
          return;
        }
      }
    }

    btn.disabled = true;
    window.PontoStorage.baterPonto().then(function (dia) {
      vibrar([80, 40, 80]);
      btn.classList.add('sucesso');
      setTimeout(function () { btn.classList.remove('sucesso'); }, 1200);
      var b = (dia && dia.batidas) || [];
      var ultima = b.length ? b[b.length - 1] : '';
      if (dia && dia.pendente) {
        // Falha de rede: o storage resolve com pendente=true (nada se perdeu).
        var erroP = window.PontoStorage.ultimoErroSync ? window.PontoStorage.ultimoErroSync() : null;
        toast('Batida gravada no celular. Envio ao GitHub falhou: ' +
          ((erroP && erroP.mensagem) || 'sem conexão') + ' Reenvie pelo aviso na tela.', 'erro');
      } else {
        toast('Ponto registrado' + (ultima ? ' às ' + ultima : '') + '.', 'ok');
      }
      // mantém o mês em memória coerente para o card "Meta do mês"
      if (!estado.mesHoje) estado.mesHoje = {};
      if (dia) estado.mesHoje[estado.isoHoje] = dia;
      invalidarCacheMes(estado.isoHoje);
      renderHoje(dia); // agenda/cancela o lembrete e atualiza o banner
    }).catch(function (err) {
      vibrar(250);
      if (err && err.dia) {
        // A batida ESTÁ salva no aparelho (cache + fila de pendências);
        // só o envio ao GitHub falhou. Deixa isso claro e mostra o banner.
        toast('Batida gravada no celular. Envio ao GitHub falhou: ' +
          msgErro(err) + ' Reenvie pelo aviso na tela.', 'erro');
        renderHoje(err.dia);
      } else {
        toast(msgErro(err), 'erro');
        atualizarBannerPendentes();
      }
    }).then(function () {
      btn.disabled = false;
    });
  }

  function fecharModalIntervalo() { $('modal-intervalo').classList.add('oculto'); }

  /* ================================================================
   * LEMBRETE DE FIM DE INTERVALO (1h após a 2ª batida)
   * setTimeout enquanto o app está aberto; reagendado ao reabrir.
   * ================================================================ */
  var lembreteTimer = null;

  function lembreteAtivo() {
    try { return localStorage.getItem('ponto.lembrete') !== '0'; } catch (e) { return true; }
  }
  function setLembreteAtivo(v) {
    try { localStorage.setItem('ponto.lembrete', v ? '1' : '0'); } catch (e) { /* ignora */ }
  }

  function cancelarLembrete() {
    if (lembreteTimer !== null) { clearTimeout(lembreteTimer); lembreteTimer = null; }
  }

  /* Agenda a notificação para completar 60 min desde a 2ª batida.
   * Reagendar é idempotente: sempre recalcula o tempo restante (ex.: app
   * reaberto 40 min depois da saída -> dispara em 20 min). */
  function agendarLembrete(dia) {
    cancelarLembrete();
    if (!lembreteAtivo()) return;
    var b = (dia && dia.batidas) || [];
    if (b.length !== 2) return;
    var dec = minutosDesde(b[1]);
    if (dec === null || dec >= INTERVALO_MINIMO_MIN) return;
    lembreteTimer = setTimeout(dispararLembrete, (INTERVALO_MINIMO_MIN - dec) * 60000);
  }

  function dispararLembrete() {
    lembreteTimer = null;
    // Só notifica se ainda estiver no intervalo (a 3ª batida cancela).
    var b = (estado.diaHoje && estado.diaHoje.batidas) || [];
    if (b.length !== 2 || !lembreteAtivo()) return;
    vibrar([200, 100, 200]);
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var titulo = 'Intervalo de 1h completo — hora de bater o retorno!';
    var opcoes = {
      body: 'Toque para abrir o Ponto e registrar o retorno do almoço.',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'ponto-intervalo',
      vibrate: [200, 100, 200]
    };
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg && reg.showNotification) reg.showNotification(titulo, opcoes);
        else new Notification(titulo, opcoes);
      }).catch(function () {
        try { new Notification(titulo, opcoes); } catch (e) { /* ignora */ }
      });
    } else {
      try { new Notification(titulo, opcoes); } catch (e) { /* ignora */ }
    }
  }

  function aoMudarLembrete() {
    var ligado = $('cfg-lembrete').checked;
    setLembreteAtivo(ligado);
    if (ligado) {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      agendarLembrete(estado.diaHoje);
    } else {
      cancelarLembrete();
    }
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
      } else if (r.feriado) {
        etiquetas += '<span class="etiqueta et-tipo">' + esc(r.feriado) + '</span>';
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
    aplicarFeriados();          // idem: o ano pode ter mudado
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
      invalidarCacheMes(estado.modal.dataISO);
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
   * TELA FINANCEIRO — acompanhamento mês a mês do ano inteiro
   * ================================================================ */
  function chaveMes(ano, mes) { return ano + '-' + pad2(mes); }

  function invalidarCacheMes(iso) {
    var p = partes(iso);
    delete cacheMeses[chaveMes(p.ano, p.mes)];
    estado.fin.carregado = false;
  }

  function carregarMesCache(ano, mes) {
    var k = chaveMes(ano, mes);
    if (cacheMeses[k]) return Promise.resolve(cacheMeses[k]);
    return window.PontoStorage.carregarMes(ano, mes).then(function (res) {
      var dias = (res && res.dias) || {};
      cacheMeses[k] = dias;
      return dias;
    });
  }

  // Um mês "tem dados" quando existe pelo menos uma batida registrada.
  // Meses sem nenhuma batida não entram no total do ano (senão um mês em
  // branco cobraria os R$ do contrato sem nenhum trabalho lançado).
  function mesTemDados(dias, ano, mes) {
    var n = diasNoMes(ano, mes);
    for (var d = 1; d <= n; d++) {
      var x = dias[montarISO(ano, mes, d)];
      if (x && x.batidas && x.batidas.length) return true;
    }
    return false;
  }

  function mudarAno(delta) {
    estado.fin.ano += delta;
    estado.fin.carregado = false;
    aplicarFeriados();          // o ano novo pode ter feriados ainda não mapeados
    carregarFin();
  }

  function carregarFin() {
    if (!contratoOK()) return;
    var ano = estado.fin.ano;
    var hoje = partes(estado.isoHoje);
    $('rotulo-ano').textContent = String(ano);
    $('fin-erro').classList.add('oculto');

    if (estado.fin.carregado) { renderFin(); return; }

    if (ano > hoje.ano) { // ano futuro: nada a mostrar
      estado.fin.meses = [];
      estado.fin.carregado = true;
      renderFin();
      return;
    }

    var cfg = configAtual();
    if (!configPronta(cfg)) {
      estado.fin.meses = [];
      estado.fin.carregado = true;
      renderFin();
      return;
    }

    var ultimo = (ano === hoje.ano) ? hoje.mes : 12;
    var c0 = contratoAtual();
    var pedidos = [];
    for (var m = 1; m <= ultimo; m++) {
      // Mês anterior ao início do contrato não precisa ir na rede.
      pedidos.push(window.PontoCalc.mesForaDoContrato(ano, m, c0)
        ? Promise.resolve({}) : carregarMesCache(ano, m));
    }

    $('fin-carregando').classList.remove('oculto');
    $('fin-lista').innerHTML = '';
    Promise.all(pedidos).then(function (lista) {
      estado.fin.meses = lista.map(function (dias, i) {
        return montarMesFin(ano, i + 1, dias, hoje);
      });
      estado.fin.carregado = true;
      renderFin();
    }).catch(function (err) {
      var e = $('fin-erro');
      e.innerHTML = '<span>' + esc(msgErro(err)) + '</span>';
      e.classList.remove('oculto');
      estado.fin.meses = [];
      renderFin();
    }).then(function () {
      $('fin-carregando').classList.add('oculto');
    });
  }

  function montarMesFin(ano, mes, dias, hoje) {
    var C = window.PontoCalc;
    var c = contratoAtual();
    var iniISO = montarISO(ano, mes, 1);
    var fimISO = montarISO(ano, mes, diasNoMes(ano, mes));
    var resumo = C.resumoPeriodo(dias, iniISO, fimISO, estado.isoHoje);
    var atual = (ano === hoje.ano && mes === hoje.mes);

    // No mês corrente soma o período ainda em aberto (mesmo número do card
    // "Meta do mês" da aba Hoje).
    var totalMin = resumo.totalMin + (atual ? minutosEmAberto() : 0);
    var baseMin = C.baseMesMin(ano, mes, c);
    var f = C.calcularValores(totalMin, baseMin, c);
    var fora = C.mesForaDoContrato(ano, mes, c);
    var temDados = !fora && mesTemDados(dias, ano, mes);

    return {
      ano: ano, mes: mes, atual: atual, parcial: atual, temDados: temDados,
      foraContrato: fora,
      diasTrabalhados: resumo.diasTrabalhados,
      totalMin: totalMin, baseMin: baseMin,
      extraMin: f.extraMin, faltaMin: f.faltaMin,
      valorHora: f.valorHora, valorBase: f.valorBase, valorExtra: f.valorExtra,
      desconto: f.desconto, total: temDados ? f.total : 0,
      progresso: f.progresso, contrato: f.contrato
    };
  }

  function renderFin() {
    var C = window.PontoCalc;
    var R = window.PontoRelatorios;
    var meses = estado.fin.meses || [];
    var t = R.totaisAnuais(meses);

    $('ano-total').textContent = C.fmtBRL(t.valor);
    $('ano-horas').textContent = C.fmtMin(t.totalMin);
    $('ano-base').textContent = C.fmtMin(t.baseMin);
    $('ano-extras').textContent = t.extraMin > 0 ? '+' + C.fmtMin(t.extraMin) : '00:00';

    var temAtual = meses.some(function (m) { return m.atual && m.temDados; });
    $('ano-sub').textContent = t.meses === 0
      ? 'Nenhum mês com registros em ' + estado.fin.ano + '.'
      : t.meses + (t.meses === 1 ? ' mês com registros' : ' meses com registros') +
        (temAtual ? ' — o mês atual ainda está em andamento.' : '.');

    renderGraficoFin(meses);
    renderListaFin(meses);

    var vazio = (t.meses === 0);
    $('btn-ano-pdf').disabled = vazio;
    $('btn-ano-excel').disabled = vazio;
    $('card-grafico').classList.toggle('oculto', !meses.some(function (m) { return !m.foraContrato; }));
  }

  function renderGraficoFin(meses) {
    var C = window.PontoCalc;
    var el = $('fin-grafico');
    meses = (meses || []).filter(function (m) { return !m.foraContrato; });
    if (!meses.length) { el.innerHTML = ''; return; }

    var teto = 1;
    meses.forEach(function (m) {
      teto = Math.max(teto, m.totalMin, m.baseMin);
    });

    var html = '';
    for (var i = 0; i < meses.length; i++) {
      var m = meses[i];
      var hBarra = Math.round((m.totalMin / teto) * 100);
      var hMeta = Math.round((m.baseMin / teto) * 100);
      var bateu = m.totalMin >= m.baseMin && m.baseMin > 0;
      html += '<div class="g-col' + (m.atual ? ' atual' : '') + '" title="' +
          esc(R_nomeMes(m.mes) + ': ' + C.fmtMin(m.totalMin) + ' de ' + C.fmtMin(m.baseMin)) + '">' +
        '<div class="g-haste">' +
          '<div class="g-meta" style="bottom:' + hMeta + '%"></div>' +
          '<div class="g-barra' + (bateu ? ' ok' : '') + '" style="height:' + hBarra + '%"></div>' +
        '</div>' +
        '<div class="g-rot">' + esc(R_nomeMes(m.mes).slice(0, 3)) + '</div>' +
      '</div>';
    }
    el.innerHTML = html;
  }

  function R_nomeMes(mes) { return window.PontoRelatorios.nomeMesPt(mes); }

  function renderListaFin(meses) {
    var C = window.PontoCalc;
    var el = $('fin-lista');
    var forasteiros = (meses || []).filter(function (m) { return m.foraContrato; }).length;
    meses = (meses || []).filter(function (m) { return !m.foraContrato; });
    if (!meses.length) {
      el.innerHTML = '<div class="vazio">Sem meses de contrato neste ano.</div>';
      return;
    }
    var html = '';
    for (var i = meses.length - 1; i >= 0; i--) { // mais recente primeiro
      var m = meses[i];
      var saldo = m.totalMin - m.baseMin;
      var etiqueta = '';
      if (m.foraContrato) etiqueta = '<span class="etiqueta">Fora do contrato</span>';
      else if (m.atual) etiqueta = '<span class="etiqueta et-aberto">Em andamento</span>';
      else if (!m.temDados) etiqueta = '<span class="etiqueta et-alerta">Sem registros</span>';

      html += '<button class="linha-mes' + (m.temDados ? '' : ' vazio-mes') +
          '" type="button" data-mes="' + m.mes + '">' +
        '<span class="mes-info">' +
          '<span class="mes-nome">' + esc(R_nomeMes(m.mes)) + etiqueta + '</span><br>' +
          '<span class="mes-horas">' + C.fmtMin(m.totalMin) + ' de ' + C.fmtMin(m.baseMin) +
            (m.temDados ? ' · ' + m.diasTrabalhados + ' dia(s)' : '') + '</span>' +
        '</span>' +
        '<span class="mes-dir">' +
          '<span class="mes-valor">' + (m.temDados ? C.fmtBRL(m.total) : '—') + '</span><br>' +
          '<span class="mes-saldo ' + classeSaldo(m.temDados ? saldo : 0) + '">' +
            (m.temDados ? C.fmtSaldo(saldo) : '') + '</span>' +
        '</span>' +
      '</button>';
    }
    if (forasteiros) {
      html += '<div class="vazio">' + forasteiros +
        (forasteiros === 1 ? ' mês anterior' : ' meses anteriores') +
        ' ao início do contrato ' + (forasteiros === 1 ? 'foi ocultado' : 'foram ocultados') + '.</div>';
    }
    el.innerHTML = html;

    var linhas = el.querySelectorAll('.linha-mes');
    for (var j = 0; j < linhas.length; j++) {
      linhas[j].addEventListener('click', function () {
        abrirModalMes(+this.getAttribute('data-mes'));
      });
    }
  }

  /* ---------- Modal com o detalhe do fechamento de um mês ---------- */
  function abrirModalMes(mes) {
    var C = window.PontoCalc;
    var m = null;
    for (var i = 0; i < estado.fin.meses.length; i++) {
      if (estado.fin.meses[i].mes === mes) { m = estado.fin.meses[i]; break; }
    }
    if (!m) return;
    estado.fin.mesAberto = m;

    $('modal-mes-titulo').textContent = R_nomeMes(m.mes) + ' de ' + m.ano;
    var pct = Math.round((m.progresso || 0) * 100);
    var barra = $('modal-mes-barra');
    barra.style.width = Math.max(0, Math.min(100, pct)) + '%';
    barra.classList.toggle('completa', m.totalMin >= m.baseMin && m.baseMin > 0);

    var c = m.contrato || contratoAtual();
    if (m.foraContrato) {
      // Mês anterior ao contrato: nada a cobrar, nada a comparar.
      $('modal-mes-tabela').innerHTML =
        '<tr><td>Situação</td><td>Fora do contrato</td></tr>' +
        '<tr><td>Início do contrato</td><td>' + esc(C.formatarDataBR(c.inicio)) + '</td></tr>' +
        '<tr><td>Total a cobrar</td><td>R$ 0,00</td></tr>';
      $('modal-mes-obs').textContent =
        'Mês anterior ao início do contrato — não gera meta nem valor.';
      barra.style.width = '0%';
      $('modal-mes').classList.remove('oculto');
      return;
    }
    var linhas = [
      ['Horas contratadas', C.fmtMin(m.baseMin) + ' (' + C.fmtHorasDec(m.baseMin) + ')'],
      ['Horas trabalhadas', C.fmtMin(m.totalMin) + ' (' + C.fmtHorasDec(m.totalMin) + ')'],
      ['Progresso', pct + '%'],
      ['Valor da hora', C.fmtBRL(m.valorHora)],
      ['Valor fixo do mês', C.fmtBRL(m.valorBase)]
    ];
    if (m.extraMin > 0) {
      linhas.push([
        'Horas extras' + (c.multiplicadorExtra !== 1 ? ' (×' + numBR(c.multiplicadorExtra) + ')' : ''),
        C.fmtMin(m.extraMin) + ' = ' + C.fmtBRL(m.valorExtra)
      ]);
    } else if (m.faltaMin > 0) {
      linhas.push(['Horas faltantes', '-' + C.fmtMin(m.faltaMin) +
        (m.desconto > 0 ? ' = -' + C.fmtBRL(m.desconto) : ' (sem desconto)')]);
    }
    linhas.push([m.atual ? 'Previsto até agora' : 'Total a cobrar',
      m.temDados ? C.fmtBRL(m.total) : 'R$ 0,00']);

    var html = '';
    for (var k = 0; k < linhas.length; k++) {
      html += '<tr><td>' + esc(linhas[k][0]) + '</td><td>' + esc(linhas[k][1]) + '</td></tr>';
    }
    $('modal-mes-tabela').innerHTML = html;

    var obs;
    if (m.foraContrato) obs = 'Mês anterior ao início do contrato — não gera meta nem valor.';
    else if (!m.temDados) obs = 'Nenhuma batida registrada neste mês — ele não entra no total do ano.';
    else if (m.atual) obs = 'Mês em andamento: o valor muda conforme você bate o ponto.';
    else if (m.extraMin > 0) obs = C.fmtHorasDec(m.extraMin) + ' acima da meta = ' +
      C.fmtBRL(m.valorExtra) + ' de hora extra.';
    else obs = 'Fechou ' + C.fmtHorasDec(m.faltaMin) + ' abaixo da meta' +
      (m.desconto > 0 ? ', com desconto de ' + C.fmtBRL(m.desconto) + '.' : ' (sem desconto no valor fixo).');
    $('modal-mes-obs').textContent = obs;

    $('modal-mes').classList.remove('oculto');
  }

  function fecharModalMes() { $('modal-mes').classList.add('oculto'); }

  function irParaHistoricoDoMes() {
    var m = estado.fin.mesAberto;
    if (!m) return;
    fecharModalMes();
    estado.hist.ano = m.ano;
    estado.hist.mes = m.mes;
    mostrarAba('historico');
  }

  function irParaRelatorioDoMes() {
    var m = estado.fin.mesAberto;
    if (!m) return;
    fecharModalMes();
    $('rel-tipo').value = 'mensal';
    $('rel-data').value = montarISO(m.ano, m.mes, 1);
    mostrarAba('relatorios');
  }

  function baixarAnual(formato) {
    var meses = estado.fin.meses || [];
    if (!meses.length) { toast('Nada para exportar neste ano.', 'erro'); return; }
    try {
      var meta = { nome: getNome() || 'Colaborador', contrato: contratoAtual() };
      if (formato === 'pdf') window.PontoRelatorios.gerarAnualPDF(estado.fin.ano, meses, meta);
      else window.PontoRelatorios.gerarAnualExcel(estado.fin.ano, meses, meta);
      toast('Download iniciado.', 'ok');
    } catch (err) {
      toast(msgErro(err), 'erro');
    }
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
    $('card-financeiro').classList.add('oculto');
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
      renderFinanceiro(tipo, resumo, faixa);
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
      if (d.tipo && d.tipo !== 'normal') batidas += ' (' + (NOMES_TIPO[d.tipo] || d.tipo) + ')';
      else if (d.feriado) batidas += ' (' + d.feriado + ')';
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

  /* Fechamento financeiro — só faz sentido no relatório MENSAL, que é o
   * documento de cobrança. Semanal/diário mostram apenas horas. */
  function renderFinanceiro(tipo, resumo, faixa) {
    var C = window.PontoCalc;
    var card = $('card-financeiro');
    estado.rel.financeiro = null;

    if (tipo !== 'mensal') { card.classList.add('oculto'); return; }

    var p = partes(faixa.inicioISO);
    var c = contratoAtual();
    var baseMin = C.baseMesMin(p.ano, p.mes, c);
    var f = C.calcularValores(resumo.totalMin, baseMin, c);
    estado.rel.financeiro = f;

    var linhas = [
      ['Horas contratadas no mês', C.fmtMin(baseMin) + ' (' + C.fmtHorasDec(baseMin) + ')'],
      ['Horas trabalhadas', C.fmtMin(resumo.totalMin) + ' (' + C.fmtHorasDec(resumo.totalMin) + ')'],
      ['Valor da hora', C.fmtBRL(f.valorHora)],
      ['Valor fixo do mês', C.fmtBRL(f.valorBase)]
    ];
    if (f.extraMin > 0) {
      linhas.push([
        'Horas extras' + (c.multiplicadorExtra !== 1 ? ' (×' + String(c.multiplicadorExtra).replace('.', ',') + ')' : ''),
        C.fmtMin(f.extraMin) + ' = ' + C.fmtBRL(f.valorExtra)
      ]);
    } else if (f.faltaMin > 0) {
      linhas.push(['Horas faltantes',
        '-' + C.fmtMin(f.faltaMin) + (f.desconto > 0 ? ' = -' + C.fmtBRL(f.desconto) : ' (sem desconto)')]);
    }
    linhas.push(['Total a cobrar', C.fmtBRL(f.total)]);

    var html = '';
    for (var i = 0; i < linhas.length; i++) {
      html += '<tr><td>' + esc(linhas[i][0]) + '</td><td>' + esc(linhas[i][1]) + '</td></tr>';
    }
    $('fin-tabela').innerHTML = html;
    $('fin-obs').textContent = 'Base: ' + (c.baseModo === 'fixo'
      ? c.baseHoras + ' h fixas por mês.'
      : C.diasUteisNoMes(p.ano, p.mes, c.inicio) + ' dias úteis × ' + (c.jornadaSemanalH / 5) + ' h.') +
      (c.inicio ? ' Contrato a partir de ' + C.formatarDataBR(c.inicio) + '.' : '') +
      ' Ajuste em Config › Contrato e meta.';
    card.classList.remove('oculto');
  }

  function metaRelatorio() {
    return {
      nome: getNome() || 'Colaborador',
      financeiro: estado.rel.financeiro || null,
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
  // "4.500,00" / "4500" -> 4500
  function lerNumero(id, padrao) {
    var v = String($(id).value || '').trim().replace(/\./g, '').replace(',', '.');
    var n = parseFloat(v);
    return isFinite(n) ? n : padrao;
  }
  function numBR(n) {
    return String(n).replace('.', ',');
  }

  function preencherContrato() {
    var c = contratoAtual();
    $('cfg-valor').value = numBR(c.valorMensal);
    $('cfg-jornada').value = numBR(c.jornadaSemanalH);
    $('cfg-base-modo').value = c.baseModo;
    $('cfg-base-horas').value = numBR(c.baseHoras);
    $('cfg-mult').value = numBR(c.multiplicadorExtra);
    $('cfg-descontar').checked = !!c.descontarFalta;
    $('cfg-inicio').value = c.inicio || '';
    aoMudarBaseModo();
  }

  function aoMudarBaseModo() {
    $('campo-base-horas').classList.toggle('oculto', $('cfg-base-modo').value !== 'fixo');
    atualizarAvisoContrato();
  }

  // Lê os campos SEM salvar — usado para a prévia da regra em Config.
  function contratoDosCampos() {
    return window.PontoCalc.normalizarContrato({
      valorMensal: lerNumero('cfg-valor', 4500),
      jornadaSemanalH: lerNumero('cfg-jornada', 40),
      baseModo: $('cfg-base-modo').value,
      baseHoras: lerNumero('cfg-base-horas', 200),
      multiplicadorExtra: lerNumero('cfg-mult', 1),
      descontarFalta: $('cfg-descontar').checked,
      inicio: $('cfg-inicio').value
    });
  }

  function atualizarAvisoContrato() {
    var C = window.PontoCalc;
    var c = contratoDosCampos();
    var p = partes(estado.isoHoje || hojeISO());
    var baseMin = C.baseMesMin(p.ano, p.mes, c);
    var valorHora = baseMin > 0 ? c.valorMensal / (baseMin / 60) : 0;
    var txt = 'Em ' + nomeMes(p.ano, p.mes) + ': meta de <b>' + C.fmtMin(baseMin) + '</b>' +
      (c.baseModo === 'auto'
        ? ' (' + C.diasUteisNoMes(p.ano, p.mes, c.inicio) + ' dias úteis × ' + numBR(c.jornadaSemanalH / 5) + ' h)'
        : ' (fixas)') +
      ' por <b>' + C.fmtBRL(c.valorMensal) + '</b> — hora a <b>' + C.fmtBRL(valorHora) + '</b>' +
      (c.multiplicadorExtra !== 1 ? ' (extra ×' + numBR(c.multiplicadorExtra) + ')' : '') + '.';
    if (c.inicio) {
      txt += ' Contrato a partir de <b>' + C.formatarDataBR(c.inicio) + '</b>.';
    }
    $('aviso-contrato-txt').innerHTML = txt;
  }

  function preencherConfig() {
    var cfg = configAtual() || {};
    preencherContrato();
    $('cfg-nome').value = getNome();
    $('cfg-owner').value = cfg.owner || 'TarcioDiniz';
    $('cfg-repo').value = cfg.repo || 'clockin-data';
    $('cfg-token').value = cfg.token || '';
    $('cfg-demo').checked = !!cfg.demo;
    $('cfg-lembrete').checked = lembreteAtivo();
    $('cfg-regiao').value = regiaoAtual();
    renderListaFeriados();
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

    // Contrato: salva local e espelha em contrato.json (best effort), para o
    // relatório automático do GitHub Actions usar os mesmos números.
    var contrato = contratoDosCampos();
    window.PontoCalc.setContrato(contrato);
    estado.fin.carregado = false; // valores derivados mudaram
    window.PontoStorage.setContrato(contrato).then(function (r) {
      if (r && r.local && !r.remoto && !modoDemo()) {
        toast('Meta salva no aparelho, mas não subiu ao GitHub: ' + (r.erro || 'falha de envio'), 'erro');
      }
    });
    if (estado.aba === 'hoje' || estado.mesHoje) renderMetaMes();

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
    // testarConexao nunca rejeita e devolve mensagem com o status HTTP
    // quando falha (401/404/...), facilitando o diagnóstico no celular.
    window.PontoStorage.testarConexao().then(function (r) {
      if (r && r.ok) {
        toast(r.mensagem || 'Conexão com o GitHub OK.', 'ok');
        vibrar(60);
      } else {
        toast((r && r.mensagem) || 'Falha ao testar a conexão.', 'erro');
      }
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

    // Contrato financeiro antes de qualquer cálculo (define a jornada diária).
    aplicarContrato();
    herdarContratoRemoto();

    // Estado inicial de datas
    estado.isoHoje = hojeISO();
    var p = partes(estado.isoHoje);
    estado.hist.ano = p.ano;
    estado.hist.mes = p.mes;
    estado.fin.ano = p.ano;
    $('rel-data').value = estado.isoHoje;

    // Feriados: nacionais já valem sozinhos; os regionais dependem das
    // respostas guardadas. Precisa vir antes de qualquer render.
    carregarFeriadosLocais();
    herdarFeriadosRemotos();

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
    $('btn-bater').addEventListener('click', function () { baterPonto(false); });
    $('banner-pendentes').addEventListener('click', reenviarPendentes);
    $('banner-feriados').addEventListener('click', abrirFilaFeriados);

    // Modal de confirmação de feriado regional
    $('btn-feriado-folga').addEventListener('click', function () { responderFeriado('folga'); });
    $('btn-feriado-trabalho').addEventListener('click', function () { responderFeriado('trabalho'); });
    $('btn-feriado-depois').addEventListener('click', function () {
      filaFeriados.shift();
      proximoFeriado();
    });
    $('btn-feriado-fechar').addEventListener('click', function () {
      filaFeriados = [];
      proximoFeriado();
    });

    // Modal de intervalo curto (confirmação da 3ª batida antes de 1h)
    $('btn-intervalo-fechar').addEventListener('click', fecharModalIntervalo);
    $('btn-intervalo-voltar').addEventListener('click', fecharModalIntervalo);
    $('btn-intervalo-confirmar').addEventListener('click', function () {
      fecharModalIntervalo();
      baterPonto(true);
    });
    $('modal-intervalo').addEventListener('click', function (ev) {
      if (ev.target === this) fecharModalIntervalo();
    });

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

    // Financeiro
    $('btn-ano-ant').addEventListener('click', function () { mudarAno(-1); });
    $('btn-ano-prox').addEventListener('click', function () { mudarAno(1); });
    $('btn-ano-pdf').addEventListener('click', function () { baixarAnual('pdf'); });
    $('btn-ano-excel').addEventListener('click', function () { baixarAnual('excel'); });
    $('btn-mes-fechar').addEventListener('click', fecharModalMes);
    $('btn-mes-historico').addEventListener('click', irParaHistoricoDoMes);
    $('btn-mes-relatorio').addEventListener('click', irParaRelatorioDoMes);
    $('modal-mes').addEventListener('click', function (ev) {
      if (ev.target === this) fecharModalMes();
    });

    // Relatórios
    $('rel-tipo').addEventListener('change', atualizarPrevia);
    $('rel-data').addEventListener('change', atualizarPrevia);
    $('btn-pdf').addEventListener('click', function () { baixarRelatorio('pdf'); });
    $('btn-excel').addEventListener('click', function () { baixarRelatorio('excel'); });

    // Config
    $('btn-salvar-config').addEventListener('click', salvarConfig);
    $('btn-testar').addEventListener('click', testarConexao);
    $('cfg-lembrete').addEventListener('change', aoMudarLembrete);
    $('cfg-base-modo').addEventListener('change', aoMudarBaseModo);
    $('cfg-inicio').addEventListener('change', atualizarAvisoContrato);
    $('cfg-regiao').addEventListener('change', function () {
      feriadosCfg.regiao = this.value;
      salvarFeriados();
      renderListaFeriados();
      renderHoje(estado.diaHoje);
      atualizarBannerFeriados();
      atualizarAvisoContrato();
    });
    $('cfg-fer-ano').addEventListener('change', renderListaFeriados);
    $('cfg-versao').textContent = APP_VERSAO;
    $('btn-forcar-atualizacao').addEventListener('click', function () {
      toast('Atualizando…');
      forcarAtualizacao();
    });
    ['cfg-valor', 'cfg-jornada', 'cfg-base-horas', 'cfg-mult'].forEach(function (id) {
      $(id).addEventListener('input', atualizarAvisoContrato);
    });
    $('cfg-descontar').addEventListener('change', atualizarAvisoContrato);

    atualizarSelo();

    // Service Worker mínimo: habilita showNotification e instalabilidade.
    if ('serviceWorker' in navigator) {
      try {
        navigator.serviceWorker.register('sw.js?v=7').catch(function () { /* segue sem SW */ });
      } catch (e) { /* ambiente sem suporte: segue sem SW */ }
    }

    // Lembrete de fim de intervalo: se o app foi reaberto no meio do
    // intervalo, o carregarHoje() -> renderHoje() reagenda o setTimeout
    // para o tempo restante até completar 1h.

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
