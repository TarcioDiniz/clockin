/* feriados.js — calendário de feriados do Ponto.
 *
 * Regra de negócio (definida pelo Tarcio):
 *  - Feriado NACIONAL é folga automática: zera a meta do dia e reduz a meta
 *    do mês. Se ele trabalhar nesse dia, tudo o que trabalhar vira extra.
 *  - Feriado ESTADUAL (Paraíba), MUNICIPAL (Campina Grande) e PONTO
 *    FACULTATIVO só valem quando o trabalho realmente liberou o dia — então o
 *    app PERGUNTA, uma vez por data, e guarda a resposta.
 *
 * O arquivo roda igual no navegador (window.PontoFeriados) e no Node
 * (module.exports), porque o gerador de relatórios do GitHub Actions precisa
 * chegar exatamente no mesmo número que o app.
 *
 * Datas sempre em "AAAA-MM-DD" e aritmética sempre em UTC — nunca no fuso
 * local da máquina, senão o dia "escorrega" dependendo de onde roda.
 */
(function (raiz, definir) {
  'use strict';
  var api = definir();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else raiz.PontoFeriados = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- utilidades de data (UTC puro) ---------------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function iso(dt) {
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  function dia(ano, mes, d) { return iso(new Date(Date.UTC(ano, mes - 1, d))); }

  function somar(dt, n) {
    return new Date(dt.getTime() + n * 86400000);
  }

  /**
   * Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano).
   * Confere: 2024 = 31/03, 2025 = 20/04, 2026 = 05/04, 2027 = 28/03.
   */
  function pascoa(ano) {
    var a = ano % 19;
    var b = Math.floor(ano / 100);
    var c = ano % 100;
    var d = Math.floor(b / 4);
    var e = b % 4;
    var f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4);
    var k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    var n = h + l - 7 * m + 114;
    return new Date(Date.UTC(ano, Math.floor(n / 31) - 1, (n % 31) + 1));
  }

  /* ---------------- regiões ---------------- */

  // Cada região acrescenta feriados estaduais/municipais aos nacionais.
  var REGIOES = {
    'nenhuma': { id: 'nenhuma', nome: 'Somente feriados nacionais' },
    'PB-CG': { id: 'PB-CG', nome: 'Campina Grande — PB' }
  };
  var REGIAO_PADRAO = 'PB-CG';

  function normalizarRegiao(id) {
    return REGIOES[id] ? id : REGIAO_PADRAO;
  }

  /* ---------------- tabelas ---------------- */

  // Feriados nacionais por lei federal. Consciência Negra virou nacional pela
  // Lei 14.759/2023 — antes disso não valia em todo o país.
  function nacionais(ano) {
    var p = pascoa(ano);
    var lista = [
      { data: dia(ano, 1, 1), nome: 'Confraternização Universal' },
      { data: iso(somar(p, -2)), nome: 'Sexta-feira Santa' },
      { data: dia(ano, 4, 21), nome: 'Tiradentes' },
      { data: dia(ano, 5, 1), nome: 'Dia do Trabalho' },
      { data: dia(ano, 9, 7), nome: 'Independência do Brasil' },
      { data: dia(ano, 10, 12), nome: 'Nossa Senhora Aparecida' },
      { data: dia(ano, 11, 2), nome: 'Finados' },
      { data: dia(ano, 11, 15), nome: 'Proclamação da República' },
      { data: dia(ano, 12, 25), nome: 'Natal' }
    ];
    if (ano >= 2024) {
      lista.push({ data: dia(ano, 11, 20), nome: 'Dia da Consciência Negra' });
    }
    for (var i = 0; i < lista.length; i++) lista[i].escopo = 'nacional';
    return lista;
  }

  // Pontos facultativos federais — não são feriado por lei, mas quase todo
  // contratante libera. Por isso entram na lista de PERGUNTAR.
  function facultativos(ano) {
    var p = pascoa(ano);
    var lista = [
      { data: iso(somar(p, -48)), nome: 'Segunda-feira de Carnaval' },
      { data: iso(somar(p, -47)), nome: 'Terça-feira de Carnaval' },
      { data: iso(somar(p, -46)), nome: 'Quarta-feira de Cinzas' },
      { data: iso(somar(p, 60)), nome: 'Corpus Christi' },
      { data: dia(ano, 10, 28), nome: 'Dia do Servidor Público' },
      { data: dia(ano, 12, 24), nome: 'Véspera de Natal' },
      { data: dia(ano, 12, 31), nome: 'Véspera de Ano Novo' }
    ];
    for (var i = 0; i < lista.length; i++) lista[i].escopo = 'facultativo';
    return lista;
  }

  // Paraíba + Campina Grande.
  function regionais(ano, regiaoId) {
    if (normalizarRegiao(regiaoId) !== 'PB-CG') return [];
    return [
      { data: dia(ano, 8, 5), nome: 'Fundação do Estado da Paraíba', escopo: 'estadual' },
      { data: dia(ano, 6, 24), nome: 'São João', escopo: 'municipal' },
      { data: dia(ano, 10, 11), nome: 'Emancipação de Campina Grande', escopo: 'municipal' },
      { data: dia(ano, 12, 8), nome: 'Nossa Senhora da Conceição', escopo: 'municipal' }
    ];
  }

  var ROTULO_ESCOPO = {
    nacional: 'feriado nacional',
    estadual: 'feriado estadual (PB)',
    municipal: 'feriado municipal (Campina Grande)',
    facultativo: 'ponto facultativo'
  };

  /**
   * Todos os feriados do ano, ordenados por data.
   * Cada item: {data, nome, escopo, automatico}
   * automatico = true só para nacional (não precisa perguntar).
   */
  function doAno(ano, regiaoId) {
    var todos = nacionais(ano)
      .concat(regionais(ano, regiaoId))
      .concat(facultativos(ano));

    // Se uma data cai em dois escopos, o mais forte manda (nacional > estadual
    // > municipal > facultativo) — evita perguntar sobre um dia que já é folga.
    var peso = { nacional: 4, estadual: 3, municipal: 2, facultativo: 1 };
    var porData = {};
    for (var i = 0; i < todos.length; i++) {
      var f = todos[i];
      var atual = porData[f.data];
      if (!atual || peso[f.escopo] > peso[atual.escopo]) porData[f.data] = f;
    }

    var saida = [];
    for (var k in porData) {
      if (!Object.prototype.hasOwnProperty.call(porData, k)) continue;
      var it = porData[k];
      saida.push({
        data: it.data,
        nome: it.nome,
        escopo: it.escopo,
        rotulo: ROTULO_ESCOPO[it.escopo] || it.escopo,
        automatico: it.escopo === 'nacional'
      });
    }
    saida.sort(function (a, b) { return a.data < b.data ? -1 : (a.data > b.data ? 1 : 0); });
    return saida;
  }

  /** O feriado de uma data específica, ou null. */
  function doDia(dataISO, regiaoId) {
    if (typeof dataISO !== 'string' || dataISO.length < 10) return null;
    var lista = doAno(+dataISO.slice(0, 4), regiaoId);
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].data === dataISO) return lista[i];
    }
    return null;
  }

  /* ---------------- decisões do usuário ---------------- */

  // decisoes: { "AAAA-MM-DD": "folga" | "trabalho" }
  function decisaoDe(decisoes, dataISO) {
    var v = decisoes && decisoes[dataISO];
    return (v === 'folga' || v === 'trabalho') ? v : '';
  }

  /**
   * Situação de cada feriado do ano depois de aplicar as decisões.
   * folga    = zera a meta do dia (e some dos dias úteis do mês)
   * pendente = precisa perguntar ao usuário
   */
  function situacaoDoAno(ano, regiaoId, decisoes) {
    var lista = doAno(ano, regiaoId);
    for (var i = 0; i < lista.length; i++) {
      var f = lista[i];
      var d = decisaoDe(decisoes, f.data);
      f.decisao = d;
      f.folga = f.automatico || d === 'folga';
      f.pendente = !f.automatico && !d;
    }
    return lista;
  }

  /**
   * Mapa { "AAAA-MM-DD": "nome do feriado" } dos dias que NÃO têm meta,
   * cobrindo todos os anos entre as duas datas. É isso que o motor de
   * cálculo consome.
   */
  function folgas(deISO, ateISO, regiaoId, decisoes) {
    var mapa = {};
    if (!deISO || !ateISO || ateISO < deISO) return mapa;
    var a1 = +deISO.slice(0, 4), a2 = +ateISO.slice(0, 4);
    for (var ano = a1; ano <= a2; ano++) {
      var lista = situacaoDoAno(ano, regiaoId, decisoes);
      for (var i = 0; i < lista.length; i++) {
        var f = lista[i];
        if (f.folga && f.data >= deISO && f.data <= ateISO) mapa[f.data] = f.nome;
      }
    }
    return mapa;
  }

  /** Mapa de folgas de um mês inteiro (atalho usado pelo cálculo da meta). */
  function folgasDoMes(ano, mes, regiaoId, decisoes) {
    var ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    return folgas(dia(ano, mes, 1), dia(ano, mes, ultimo), regiaoId, decisoes);
  }

  /**
   * Feriados que ainda precisam de resposta, dentro de um intervalo.
   * Sábado e domingo são descartados: não muda nada perguntar sobre eles.
   */
  function pendentes(deISO, ateISO, regiaoId, decisoes) {
    var saida = [];
    if (!deISO || !ateISO || ateISO < deISO) return saida;
    var a1 = +deISO.slice(0, 4), a2 = +ateISO.slice(0, 4);
    for (var ano = a1; ano <= a2; ano++) {
      var lista = situacaoDoAno(ano, regiaoId, decisoes);
      for (var i = 0; i < lista.length; i++) {
        var f = lista[i];
        if (!f.pendente || f.data < deISO || f.data > ateISO) continue;
        var dow = new Date(Date.UTC(
          +f.data.slice(0, 4), +f.data.slice(5, 7) - 1, +f.data.slice(8, 10)
        )).getUTCDay();
        if (dow === 0 || dow === 6) continue;   // fim de semana: irrelevante
        saida.push(f);
      }
    }
    return saida;
  }

  return {
    REGIOES: REGIOES,
    REGIAO_PADRAO: REGIAO_PADRAO,
    ROTULO_ESCOPO: ROTULO_ESCOPO,
    normalizarRegiao: normalizarRegiao,
    pascoa: pascoa,
    nacionais: nacionais,
    facultativos: facultativos,
    regionais: regionais,
    doAno: doAno,
    doDia: doDia,
    situacaoDoAno: situacaoDoAno,
    folgas: folgas,
    folgasDoMes: folgasDoMes,
    pendentes: pendentes
  };
});
