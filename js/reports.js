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

  /* ---------------- contrato financeiro (meta + valores) ----------------
   * Regra combinada:
   *   - Jornada 40h/semana => 8h por dia útil (seg-sex).
   *   - Meta do mês (modo "auto") = dias úteis do mês x jornada diária.
   *   - Valor/hora = valor mensal / horas-base do mês.
   *   - O que passar da meta do mês é EXTRA, pago a valor/hora x multiplicador.
   *   - Faltando horas: por padrão o valor mensal é mantido e a falta só é
   *     sinalizada (descontarFalta = true muda isso).
   * O MESMO contrato está em scripts/gerar-relatorio.js (contrato.json).
   * -------------------------------------------------------------------- */

  var CONTRATO_PADRAO = {
    valorMensal: 4500,        // R$ fechados no mês
    jornadaSemanalH: 40,      // horas por semana (5 dias úteis)
    baseModo: 'auto',         // 'auto' = dias úteis do mês x jornada diária | 'fixo'
    baseHoras: 200,           // horas-base quando baseModo === 'fixo'
    multiplicadorExtra: 1,    // 1 = hora extra pelo mesmo valor; 1.5 = +50%
    descontarFalta: false,    // descontar proporcionalmente as horas faltantes
    inicio: ''                // 'AAAA-MM-DD' — 1º dia do contrato ('' = sem limite)
  };

  var RE_ISO = /^\d{4}-\d{2}-\d{2}$/;

  // Normaliza a data de início: só aceita AAAA-MM-DD que exista de verdade.
  function dataContrato(v) {
    if (typeof v !== 'string' || !RE_ISO.test(v)) return '';
    var p = v.split('-');
    var a = +p[0], m = +p[1], d = +p[2];
    if (m < 1 || m > 12 || d < 1 || d > 31) return '';
    var dt = new Date(Date.UTC(a, m - 1, d));
    if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
    return v;
  }

  function num(v, padrao) {
    var n = typeof v === 'string' ? parseFloat(String(v).replace(',', '.')) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : padrao;
  }

  // Sempre devolve um contrato completo e sensato (nunca NaN, nunca zero divisor).
  function normalizarContrato(c) {
    c = c || {};
    var jornada = num(c.jornadaSemanalH, CONTRATO_PADRAO.jornadaSemanalH);
    if (jornada <= 0 || jornada > 84) jornada = CONTRATO_PADRAO.jornadaSemanalH;
    var mult = num(c.multiplicadorExtra, CONTRATO_PADRAO.multiplicadorExtra);
    if (mult <= 0 || mult > 5) mult = CONTRATO_PADRAO.multiplicadorExtra;
    var baseH = num(c.baseHoras, CONTRATO_PADRAO.baseHoras);
    if (baseH <= 0 || baseH > 744) baseH = CONTRATO_PADRAO.baseHoras;
    var valor = num(c.valorMensal, CONTRATO_PADRAO.valorMensal);
    if (valor < 0) valor = 0;
    return {
      valorMensal: valor,
      jornadaSemanalH: jornada,
      baseModo: c.baseModo === 'fixo' ? 'fixo' : 'auto',
      baseHoras: baseH,
      multiplicadorExtra: mult,
      descontarFalta: !!c.descontarFalta,
      inicio: dataContrato(c.inicio)
    };
  }

  // Contrato "ativo" do app (definido pela tela Config). Mantém as duas
  // pontas — KPIs da tela Hoje e relatórios — usando a MESMA jornada diária.
  var contratoAtivo = normalizarContrato(CONTRATO_PADRAO);

  function setContrato(c) {
    contratoAtivo = normalizarContrato(c);
    return contratoAtivo;
  }
  function getContrato() {
    return normalizarContrato(contratoAtivo);
  }

  // Jornada diária em minutos: 40h/semana / 5 dias úteis = 480 min.
  function metaDiaMin(contrato) {
    return Math.round(normalizarContrato(contrato || contratoAtivo).jornadaSemanalH * 60 / 5);
  }

  function diasNoMes(ano, mes) {
    return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  }

  // Dias úteis (seg-sex) do mês inteiro, independente de "hoje".
  // Com inicioISO, conta só os dias úteis a partir do 1º dia do contrato —
  // é o que faz o mês de entrada ter meta proporcional.
  function diasUteisNoMes(ano, mes, inicioISO) {
    var ini = dataContrato(inicioISO);
    var n = diasNoMes(ano, mes), c = 0, min = 1;
    if (ini) {
      var p = ini.split('-'), ia = +p[0], im = +p[1];
      if (ano < ia || (ano === ia && mes < im)) return 0;   // mês antes do contrato
      if (ano === ia && mes === im) min = +p[2];
    }
    for (var d = min; d <= n; d++) {
      var dow = new Date(Date.UTC(ano, mes - 1, d)).getUTCDay();
      if (dow >= 1 && dow <= 5) c++;
    }
    return c;
  }

  // true quando o mês inteiro é anterior ao início do contrato.
  function mesForaDoContrato(ano, mes, contrato) {
    var c = normalizarContrato(contrato || contratoAtivo);
    if (!c.inicio) return false;
    var p = c.inicio.split('-');
    return ano < +p[0] || (ano === +p[0] && mes < +p[1]);
  }

  // Horas-base do MÊS FECHADO em minutos (não encolhe no meio do mês —
  // é a referência contratual, não o quanto já venceu). No mês em que o
  // contrato começa, a base é proporcional aos dias úteis contratados.
  function baseMesMin(ano, mes, contrato) {
    var c = normalizarContrato(contrato || contratoAtivo);
    if (mesForaDoContrato(ano, mes, c)) return 0;
    var uteis = diasUteisNoMes(ano, mes, c.inicio);
    if (c.baseModo === 'fixo') {
      var cheio = diasUteisNoMes(ano, mes);
      if (cheio <= 0 || uteis >= cheio) return Math.round(c.baseHoras * 60);
      return Math.round(c.baseHoras * 60 * uteis / cheio);  // mês de entrada
    }
    return uteis * metaDiaMin(c);
  }

  /**
   * Fechamento financeiro do mês.
   * @param {number} totalMin  minutos efetivamente trabalhados no mês
   * @param {number} baseMin   horas-base do mês em minutos (ver baseMesMin)
   * @param {object} contrato
   */
  function calcularValores(totalMin, baseMin, contrato) {
    var c = normalizarContrato(contrato || contratoAtivo);
    totalMin = num(totalMin, 0);
    baseMin = num(baseMin, 0);

    var valorHora = baseMin > 0 ? (c.valorMensal / (baseMin / 60)) : 0;
    var extraMin = Math.max(0, totalMin - baseMin);
    var faltaMin = Math.max(0, baseMin - totalMin);
    var valorExtra = (extraMin / 60) * valorHora * c.multiplicadorExtra;
    var desconto = c.descontarFalta ? (faltaMin / 60) * valorHora : 0;
    var total = c.valorMensal + valorExtra - desconto;
    if (total < 0) total = 0;

    return {
      contrato: c,
      baseMin: baseMin,
      totalMin: totalMin,
      valorHora: valorHora,
      extraMin: extraMin,
      faltaMin: faltaMin,
      valorBase: c.valorMensal,
      valorExtra: valorExtra,
      desconto: desconto,
      total: total,
      progresso: baseMin > 0 ? (totalMin / baseMin) : 0
    };
  }

  // 4500 -> "R$ 4.500,00"
  function fmtBRL(v) {
    if (typeof v !== 'number' || !isFinite(v)) v = 0;
    var neg = v < 0;
    var s = Math.abs(v).toFixed(2);
    var partes = s.split('.');
    partes[0] = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + 'R$ ' + partes[0] + ',' + partes[1];
  }

  // 486 -> "8,10 h" (horas decimais, útil para conferir com quem paga)
  function fmtHorasDec(min) {
    if (typeof min !== 'number' || !isFinite(min)) min = 0;
    return (min / 60).toFixed(2).replace('.', ',') + ' h';
  }

  /* ---------------- PontoCalc (API pública, funções puras) ---------------- */

  // dia: {batidas:[], obs:"", tipo:"normal|feriado|ferias|atestado|abono"} | null/undefined
  // dataISO: "AAAA-MM-DD"
  // -> {totalMin, metaMin, saldoMin, periodos, aberto, inconsistente}
  function calcularDia(dia, dataISO, metaDiaMinOpt) {
    dia = dia || {};
    var batidas = Array.isArray(dia.batidas) ? dia.batidas : [];
    var tipo = dia.tipo || 'normal';

    // Meta do dia útil: 480 min por padrão (40h/5). Vem do contrato ativo,
    // ou do parâmetro explícito (usado pelos testes).
    var metaDia = num(metaDiaMinOpt, metaDiaMin(contratoAtivo));

    // Meta: metaDia em dia útil; sáb/dom e tipos ESPECIAIS do contrato = 0.
    // Tipo desconhecido NÃO zera a meta (mesma whitelist do gerador Node).
    // Antes do 1º dia do contrato não existe meta (não gera saldo devedor).
    var especial = TIPOS_ESPECIAIS.indexOf(tipo) !== -1;
    var antesDoContrato = !!(contratoAtivo.inicio && dataISO < contratoAtivo.inicio);
    var metaMin = (!especial && !antesDoContrato && ehDiaUtil(dataISO)) ? metaDia : 0;

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
  function resumoPeriodo(diasMap, dataInicioISO, dataFimISO, hojeRefISO, metaDiaMinOpt) {
    diasMap = diasMap || {};
    var hoje = hojeRefISO || hojeISO();
    var metaDia = num(metaDiaMinOpt, metaDiaMin(contratoAtivo));

    var porDia = [];
    var totalMin = 0, metaMin = 0, diasTrabalhados = 0, diasUteis = 0;

    for (var d = dataInicioISO; d <= dataFimISO; d = addDiasISO(d, 1)) {
      var futuro = d > hoje;
      var dia = diasMap[d];
      var calc = calcularDia(dia, d, metaDia);

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
    META_DIA_UTIL_MIN: META_DIA_UTIL_MIN,
    // contrato financeiro
    CONTRATO_PADRAO: CONTRATO_PADRAO,
    normalizarContrato: normalizarContrato,
    setContrato: setContrato,
    getContrato: getContrato,
    metaDiaMin: metaDiaMin,
    diasUteisNoMes: diasUteisNoMes,
    mesForaDoContrato: mesForaDoContrato,
    baseMesMin: baseMesMin,
    calcularValores: calcularValores,
    fmtBRL: fmtBRL,
    fmtHorasDec: fmtHorasDec
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

  // Bloco "Fechamento financeiro" — mesmas linhas no PDF e no Excel.
  function linhasFinanceiro(f) {
    var c = f.contrato || {};
    var linhas = [
      ['Horas contratadas no mês', fmtMin(f.baseMin) + '  (' + fmtHorasDec(f.baseMin) + ')'],
      ['Horas trabalhadas', fmtMin(f.totalMin) + '  (' + fmtHorasDec(f.totalMin) + ')'],
      ['Valor da hora', fmtBRL(f.valorHora)],
      ['Valor fixo do mês', fmtBRL(f.valorBase)]
    ];
    if (f.extraMin > 0) {
      var rotulo = 'Horas extras' + (c.multiplicadorExtra && c.multiplicadorExtra !== 1
        ? ' (x' + String(c.multiplicadorExtra).replace('.', ',') + ')' : '');
      linhas.push([rotulo, fmtMin(f.extraMin) + '  =  ' + fmtBRL(f.valorExtra)]);
    } else if (f.faltaMin > 0) {
      linhas.push(['Horas faltantes', '-' + fmtMin(f.faltaMin) +
        (f.desconto > 0 ? '  =  -' + fmtBRL(f.desconto) : '  (sem desconto)')]);
    }
    linhas.push(['TOTAL A COBRAR', fmtBRL(f.total)]);
    return linhas;
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

    if (meta.financeiro) {
      doc.setFontSize(13);
      doc.text('Fechamento financeiro', 14, fimY + 12);
      doc.autoTable({
        startY: fimY + 16,
        head: [['Item', 'Valor']],
        body: linhasFinanceiro(meta.financeiro),
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: [22, 120, 82] },
        columnStyles: { 1: { halign: 'right' } },
        theme: 'grid',
        didParseCell: function (dados) {
          if (dados.section === 'body' &&
              dados.row.index === dados.table.body.length - 1) {
            dados.cell.styles.fontStyle = 'bold';
            dados.cell.styles.fillColor = [226, 244, 234];
          }
        }
      });
      fimY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || fimY;
    }

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

    if (meta.financeiro) {
      aoa.push([]);
      aoa.push(['Fechamento financeiro']);
      linhasFinanceiro(meta.financeiro).forEach(function (l) { aoa.push(l); });
    }

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

  /* ---------------- Extrato ANUAL (tela Financeiro) ----------------
   * meses: lista de { ano, mes, totalMin, baseMin, extraMin, faltaMin,
   *                   valorBase, valorExtra, desconto, total, temDados, parcial }
   * Só entram no total do ano os meses com registros (temDados). */

  var NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  function nomeMesPt(mes) { return NOMES_MES[mes - 1] || ('Mês ' + mes); }

  function totaisAnuais(meses) {
    var t = { totalMin: 0, baseMin: 0, extraMin: 0, faltaMin: 0, valor: 0, meses: 0 };
    (meses || []).forEach(function (m) {
      if (!m || !m.temDados) return;
      t.meses++;
      t.totalMin += num(m.totalMin, 0);
      t.baseMin += num(m.baseMin, 0);
      t.extraMin += num(m.extraMin, 0);
      t.faltaMin += num(m.faltaMin, 0);
      t.valor += num(m.total, 0);
    });
    return t;
  }

  function linhasAnual(meses) {
    return (meses || []).map(function (m) {
      if (m.foraContrato) {
        return [nomeMesPt(m.mes), '—', '—', '—', '—', 'fora do contrato'];
      }
      if (!m.temDados) {
        return [nomeMesPt(m.mes), '—', fmtMin(m.baseMin), '—', '—', 'sem registros'];
      }
      var saldo = num(m.totalMin, 0) - num(m.baseMin, 0);
      return [
        nomeMesPt(m.mes) + (m.parcial ? ' (em andamento)' : ''),
        fmtMin(m.totalMin),
        fmtMin(m.baseMin),
        fmtSaldo(saldo),
        m.extraMin > 0 ? fmtMin(m.extraMin) : '—',
        fmtBRL(m.total)
      ];
    });
  }

  function linhaTotaisAnual(meses) {
    var t = totaisAnuais(meses);
    return ['Total do ano (' + t.meses + ' mês/meses)', fmtMin(t.totalMin),
      fmtMin(t.baseMin), fmtSaldo(t.totalMin - t.baseMin),
      t.extraMin > 0 ? fmtMin(t.extraMin) : '—', fmtBRL(t.valor)];
  }

  var CABECALHO_ANUAL = ['Mês', 'Trabalhado', 'Contratado', 'Saldo', 'Extras', 'A cobrar'];

  function gerarAnualPDF(ano, meses, meta) {
    meta = meta || {};
    var jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFCtor) throw new Error('jsPDF não carregado (verifique o CDN no index.html).');

    var doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.setFontSize(16);
    doc.text('Extrato financeiro anual — ' + ano, 14, 18);
    doc.setFontSize(11);
    doc.text('Colaborador: ' + (meta.nome || '—'), 14, 27);

    var c = meta.contrato || {};
    doc.text('Contrato: ' + fmtBRL(num(c.valorMensal, 0)) + '/mês, ' +
      String(num(c.jornadaSemanalH, 0)).replace('.', ',') + 'h por semana' +
      (num(c.multiplicadorExtra, 1) !== 1
        ? ', extra x' + String(c.multiplicadorExtra).replace('.', ',') : ''), 14, 33);

    doc.autoTable({
      startY: 39,
      head: [CABECALHO_ANUAL],
      body: linhasAnual(meses),
      foot: [linhaTotaisAnual(meses)],
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [22, 120, 82] },
      footStyles: { fillColor: [226, 244, 234], textColor: [20, 20, 20], fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' },
        3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      theme: 'grid'
    });

    var fimY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || 60;
    doc.setFontSize(9);
    doc.text('Meses sem registros não entram no total. Gerado em ' + agoraBR(), 14, fimY + 10);
    doc.save('ponto-anual-' + ano + '.pdf');
  }

  function gerarAnualExcel(ano, meses, meta) {
    meta = meta || {};
    var XLSX = window.XLSX;
    if (!XLSX) throw new Error('SheetJS (XLSX) não carregado (verifique o CDN no index.html).');

    var c = meta.contrato || {};
    var aoa = [
      ['Extrato financeiro anual — ' + ano],
      ['Colaborador: ' + (meta.nome || '—')],
      ['Contrato: ' + fmtBRL(num(c.valorMensal, 0)) + '/mês, ' +
        String(num(c.jornadaSemanalH, 0)).replace('.', ',') + 'h por semana'],
      [],
      CABECALHO_ANUAL
    ];
    linhasAnual(meses).forEach(function (l) { aoa.push(l); });
    aoa.push(linhaTotaisAnual(meses));
    aoa.push([]);
    aoa.push(['Meses sem registros não entram no total.']);
    aoa.push(['Gerado em ' + agoraBR()]);

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Anual ' + ano);
    XLSX.writeFile(wb, 'ponto-anual-' + ano + '.xlsx');
  }

  window.PontoRelatorios = {
    gerarPDF: gerarPDF,
    gerarExcel: gerarExcel,
    gerarAnualPDF: gerarAnualPDF,
    gerarAnualExcel: gerarAnualExcel,
    totaisAnuais: totaisAnuais,
    nomeMesPt: nomeMesPt
  };

})(typeof window !== 'undefined' ? window : this);
