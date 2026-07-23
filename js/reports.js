/* ============================================================
 * Ponto — js/reports.js
 * window.PontoCalc      : funções PURAS de cálculo (sem DOM, sem rede)
 * window.PontoRelatorios: geração de PDF (jsPDF + autotable) e Excel (SheetJS)
 * Sem módulos ES, sem framework, sem build.
 * ============================================================ */
(function (window) {
  'use strict';

  var TZ = 'America/Sao_Paulo';
  var META_DIA_UTIL_MIN = 480; // 8h seg-sex
  // Whitelist do contrato: SOMENTE estes tipos zeram a meta.
  // Tipo desconhecido (ex.: "Feriado" capitalizado, "folga") é tratado como
  // "normal" — mesma regra de scripts/gerar-relatorio.js.
  var TIPOS_ESPECIAIS = ['feriado', 'ferias', 'atestado', 'abono'];

  var NOMES_DIA_SEMANA = [
    'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
    'quinta-feira', 'sexta-feira', 'sábado'
  ];

  /* ---------------- utilidades internas (puras) ---------------- */

  function pad2(n) {
    n = Math.floor(Math.abs(n));
    return (n < 10 ? '0' : '') + n;
  }

  // "AAAA-MM-DD" -> {ano, mes, dia}
  function parseISO(iso) {
    var p = String(iso).split('-');
    return { ano: parseInt(p[0], 10), mes: parseInt(p[1], 10), dia: parseInt(p[2], 10) };
  }

  // Dia da semana determinístico via aritmética UTC (0=domingo ... 6=sábado).
  // Não depende do fuso do host: Date.UTC é calendário puro.
  function diaSemanaIdx(dataISO) {
    var p = parseISO(dataISO);
    return new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay();
  }

  function ehDiaUtil(dataISO) {
    var d = diaSemanaIdx(dataISO);
    return d >= 1 && d <= 5;
  }

  // Soma n dias a uma data ISO (aritmética UTC pura, sem fuso local).
  function addDiasISO(dataISO, n) {
    var p = parseISO(dataISO);
    var d = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + n));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // "HH:MM" -> minutos desde 00:00. Retorna null se inválido (mesma
  // validação de scripts/gerar-relatorio.js: regex + faixa 00:00..23:59).
  function hhmmParaMin(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // "Hoje" no fuso America/Sao_Paulo, via Intl (nunca new Date() ambíguo).
  function hojeISO() {
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return fmt.format(new Date()); // en-CA => "AAAA-MM-DD"
  }

  // "22/07/2026 14:35" no fuso America/Sao_Paulo (para rodapé de relatório).
  function agoraBR() {
    var partes = new Intl.DateTimeFormat('pt-BR', {
      timeZone: TZ,
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    var m = {};
    partes.forEach(function (x) { m[x.type] = x.value; });
    return m.day + '/' + m.month + '/' + m.year + ' ' + m.hour + ':' + m.minute;
  }

  function formatarDataBR(dataISO) {
    var p = parseISO(dataISO);
    return pad2(p.dia) + '/' + pad2(p.mes) + '/' + p.ano;
  }

  /* ---------------- PontoCalc (API pública, funções puras) ---------------- */

  // dia: {batidas:[], obs:"", tipo:"normal|feriado|ferias|atestado|abono"} | null/undefined
  // dataISO: "AAAA-MM-DD"
  // -> {totalMin, metaMin, saldoMin, periodos, aberto, inconsistente}
  function calcularDia(dia, dataISO) {
    dia = dia || {};
    var batidas = Array.isArray(dia.batidas) ? dia.batidas : [];
    var tipo = dia.tipo || 'normal';

    // Meta: 480 min em dia útil; sáb/dom e tipos ESPECIAIS do contrato = 0.
    // Tipo desconhecido NÃO zera a meta (mesma whitelist do gerador Node).
    var especial = TIPOS_ESPECIAIS.indexOf(tipo) !== -1;
    var metaMin = (!especial && ehDiaUtil(dataISO)) ? META_DIA_UTIL_MIN : 0;

    // Número ímpar de batidas: período em aberto. Em dia fechado a última
    // batida sem par é ignorada no total e o dia é sinalizado inconsistente.
    var aberto = batidas.length % 2 === 1;
    var inconsistente = aberto;

    // Valida todas as batidas antes de somar (batida inválida não conta e
    // marca inconsistência — nunca propaga NaN).
    var minutos = [];
    for (var j = 0; j < batidas.length; j++) {
      minutos.push(hhmmParaMin(batidas[j]));
      if (minutos[j] === null) inconsistente = true;
    }

    var periodos = [];
    var totalMin = 0;
    for (var i = 0; i + 1 < batidas.length; i += 2) {
      var ini = minutos[i];
      var fim = minutos[i + 1];
      if (ini === null || fim === null) continue; // batida inválida: fora do total
      var dur = fim - ini;
      if (dur < 0) { inconsistente = true; continue; } // fora de ordem: sinaliza
      periodos.push({ inicio: batidas[i], fim: batidas[i + 1], minutos: dur });
      totalMin += dur;
    }

    return {
      totalMin: totalMin,
      metaMin: metaMin,
      saldoMin: totalMin - metaMin,
      periodos: periodos,
      aberto: aberto,
      inconsistente: inconsistente
    };
  }

  // diasMap: { "AAAA-MM-DD": dia, ... }
  // Inclui TODOS os dias do intervalo (mesmo vazios, com meta). Dias futuros
  // (após "hoje" em America/Sao_Paulo) não contam meta nem dia útil.
  // hojeRefISO é opcional (injeção para testes); default = hoje em SP.
  function resumoPeriodo(diasMap, dataInicioISO, dataFimISO, hojeRefISO) {
    diasMap = diasMap || {};
    var hoje = hojeRefISO || hojeISO();

    var porDia = [];
    var totalMin = 0, metaMin = 0, diasTrabalhados = 0, diasUteis = 0;

    for (var d = dataInicioISO; d <= dataFimISO; d = addDiasISO(d, 1)) {
      var futuro = d > hoje;
      var dia = diasMap[d];
      var calc = calcularDia(dia, d);

      if (futuro) {
        // Dia futuro: meta não conta (não gera saldo devedor antecipado).
        calc.metaMin = 0;
        calc.saldoMin = calc.totalMin;
      }

      porDia.push({
        dataISO: d,
        diaSemana: NOMES_DIA_SEMANA[diaSemanaIdx(d)],
        batidas: (dia && Array.isArray(dia.batidas)) ? dia.batidas.slice() : [],
        obs: (dia && dia.obs) || '',
        tipo: (dia && dia.tipo) || 'normal',
        futuro: futuro,
        totalMin: calc.totalMin,
        metaMin: calc.metaMin,
        saldoMin: calc.saldoMin,
        periodos: calc.periodos,
        aberto: calc.aberto,
        inconsistente: calc.inconsistente
      });

      totalMin += calc.totalMin;
      metaMin += calc.metaMin;
      if (calc.totalMin > 0) diasTrabalhados++;
      // Definição unificada (igual ao gerador Node): dia útil = dia com meta > 0.
      if (calc.metaMin > 0) diasUteis++;
    }

    return {
      dataInicioISO: dataInicioISO,
      dataFimISO: dataFimISO,
      porDia: porDia,
      totalMin: totalMin,
      metaMin: metaMin,
      saldoMin: totalMin - metaMin,
      diasTrabalhados: diasTrabalhados,
      diasUteis: diasUteis
    };
  }

  // Semana (segunda a domingo) que contém dataISO.
  function semanaDe(dataISO) {
    var dow = diaSemanaIdx(dataISO); // 0=dom
    var offsetSegunda = (dow === 0) ? -6 : (1 - dow);
    var inicioISO = addDiasISO(dataISO, offsetSegunda);
    return { inicioISO: inicioISO, fimISO: addDiasISO(inicioISO, 6) };
  }

  // 486 -> "08:06"
  function fmtMin(min) {
    if (typeof min !== 'number' || !isFinite(min)) min = 0; // nunca "NaN:NaN"
    var abs = Math.abs(Math.round(min));
    return pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  // 6 -> "+00:06" ; -25 -> "-00:25" ; 0 -> "+00:00"
  function fmtSaldo(min) {
    var sinal = (Math.round(min) < 0) ? '-' : '+';
    return sinal + fmtMin(min);
  }

  window.PontoCalc = {
    calcularDia: calcularDia,
    resumoPeriodo: resumoPeriodo,
    semanaDe: semanaDe,
    fmtMin: fmtMin,
    fmtSaldo: fmtSaldo,
    // auxiliares expostos (também puros) para uso do app/testes
    hojeISO: hojeISO,
    addDiasISO: addDiasISO,
    diaSemanaIdx: diaSemanaIdx,
    ehDiaUtil: ehDiaUtil,
    formatarDataBR: formatarDataBR,
    NOMES_DIA_SEMANA: NOMES_DIA_SEMANA,
    META_DIA_UTIL_MIN: META_DIA_UTIL_MIN
  };

  /* ---------------- PontoRelatorios (PDF / Excel) ---------------- */

  var TITULOS = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal' };

  function tituloRelatorio(tipo) {
    return 'Relatório de Ponto — ' + (TITULOS[tipo] || tipo);
  }

  function textoPeriodo(resumo) {
    return 'Período: ' + formatarDataBR(resumo.dataInicioISO) +
      ' a ' + formatarDataBR(resumo.dataFimISO);
  }

  // Linhas da tabela: Data, Dia da semana, Batidas, Total, Meta, Saldo
  function linhasTabela(resumo) {
    return resumo.porDia.map(function (d) {
      var batidas = d.batidas.join(' ');
      if (d.tipo && d.tipo !== 'normal') {
        batidas = (batidas ? batidas + ' ' : '') + '(' + d.tipo + ')';
      }
      if (d.inconsistente) batidas += ' (!)';
      return [
        formatarDataBR(d.dataISO),
        d.diaSemana,
        batidas || '—',
        fmtMin(d.totalMin),
        fmtMin(d.metaMin),
        fmtSaldo(d.saldoMin)
      ];
    });
  }

  function linhaTotais(resumo) {
    return [
      'Totais',
      '',
      resumo.diasTrabalhados + ' dia(s) trabalhado(s) / ' + resumo.diasUteis + ' útil(eis)',
      fmtMin(resumo.totalMin),
      fmtMin(resumo.metaMin),
      fmtSaldo(resumo.saldoMin)
    ];
  }

  function nomeArquivo(tipo, resumo, ext) {
    return 'ponto-' + tipo + '-' + resumo.dataInicioISO + '_' + resumo.dataFimISO + '.' + ext;
  }

  // tipo: "diario"|"semanal"|"mensal"; resumo: saída de PontoCalc.resumoPeriodo;
  // meta: { nome: "Colaborador", ... }
  function gerarPDF(tipo, resumo, meta) {
    meta = meta || {};
    var jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFCtor) throw new Error('jsPDF não carregado (verifique o CDN no index.html).');

    var doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    doc.setFontSize(16);
    doc.text(tituloRelatorio(tipo), 14, 18);
    doc.setFontSize(11);
    doc.text('Colaborador: ' + (meta.nome || '—'), 14, 27);
    doc.text(textoPeriodo(resumo), 14, 33);

    var corpo = linhasTabela(resumo);
    var totais = linhaTotais(resumo);

    doc.autoTable({
      startY: 38,
      head: [['Data', 'Dia da semana', 'Batidas', 'Total', 'Meta', 'Saldo']],
      body: corpo,
      foot: [totais],
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [33, 82, 155] },
      footStyles: { fillColor: [230, 236, 245], textColor: [20, 20, 20], fontStyle: 'bold' },
      theme: 'grid'
    });

    var fimY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || 60;
    doc.setFontSize(9);
    doc.text('Gerado em ' + agoraBR(), 14, fimY + 10);

    doc.save(nomeArquivo(tipo, resumo, 'pdf'));
  }

  function gerarExcel(tipo, resumo, meta) {
    meta = meta || {};
    var XLSX = window.XLSX;
    if (!XLSX) throw new Error('SheetJS (XLSX) não carregado (verifique o CDN no index.html).');

    var aoa = [
      [tituloRelatorio(tipo)],
      ['Colaborador: ' + (meta.nome || '—')],
      [textoPeriodo(resumo)],
      [],
      ['Data', 'Dia da semana', 'Batidas', 'Total', 'Meta', 'Saldo']
    ];
    linhasTabela(resumo).forEach(function (l) { aoa.push(l); });
    aoa.push(linhaTotais(resumo));
    aoa.push([]);
    aoa.push(['Gerado em ' + agoraBR()]);

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 12 }, { wch: 16 }, { wch: 34 }, { wch: 8 }, { wch: 8 }, { wch: 9 }
    ];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ponto');
    XLSX.writeFile(wb, nomeArquivo(tipo, resumo, 'xlsx'));
  }

  window.PontoRelatorios = {
    gerarPDF: gerarPDF,
    gerarExcel: gerarExcel
  };

})(typeof window !== 'undefined' ? window : this);
