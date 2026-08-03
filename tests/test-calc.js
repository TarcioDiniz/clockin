/* Testes Node puros para js/reports.js (window.PontoCalc).
 * Rodar: node ./ponto-app/tests/test-calc.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Stub de window e carga do script como no navegador (sem módulos ES).
global.window = {};
const codigo = fs.readFileSync(path.join(__dirname, '..', 'js', 'reports.js'), 'utf8');
eval(codigo);

const Calc = global.window.PontoCalc;
assert.ok(Calc, 'window.PontoCalc deve existir');
assert.ok(global.window.PontoRelatorios, 'window.PontoRelatorios deve existir');

let passaram = 0;
let falharam = 0;

function teste(nome, fn) {
  try {
    fn();
    passaram++;
    console.log('  ok  ' + nome);
  } catch (e) {
    falharam++;
    console.error('FALHA ' + nome);
    console.error('      ' + e.message);
  }
}

// Referências de calendário (2026-07): 01=quarta; sáb 04,11,18,25; dom 05,12,19,26.
// 2026-07-20 = segunda, 2026-07-22 = quarta, 2026-07-25 = sábado, 2026-07-26 = domingo.

teste('dia normal com 4 batidas (quarta-feira)', () => {
  const dia = { batidas: ['08:01', '12:02', '13:00', '17:05'], obs: '', tipo: 'normal' };
  const r = Calc.calcularDia(dia, '2026-07-22');
  assert.strictEqual(r.totalMin, 241 + 245); // 486
  assert.strictEqual(r.metaMin, 480);
  assert.strictEqual(r.saldoMin, 6);
  assert.strictEqual(r.periodos.length, 2);
  assert.strictEqual(r.periodos[0].minutos, 241);
  assert.strictEqual(r.periodos[1].minutos, 245);
  assert.strictEqual(r.aberto, false);
  assert.strictEqual(r.inconsistente, false);
});

teste('dia com 2 batidas (meio expediente)', () => {
  const r = Calc.calcularDia({ batidas: ['08:00', '12:00'] }, '2026-07-21');
  assert.strictEqual(r.totalMin, 240);
  assert.strictEqual(r.metaMin, 480);
  assert.strictEqual(r.saldoMin, -240);
  assert.strictEqual(r.periodos.length, 1);
  assert.strictEqual(r.aberto, false);
});

teste('batidas ímpares: ignora última sem par e sinaliza inconsistência', () => {
  const r = Calc.calcularDia({ batidas: ['08:00', '12:00', '13:00'] }, '2026-07-22');
  assert.strictEqual(r.totalMin, 240); // 13:00 sem par não conta
  assert.strictEqual(r.aberto, true);
  assert.strictEqual(r.inconsistente, true);
  assert.strictEqual(r.periodos.length, 1);
  assert.strictEqual(r.saldoMin, 240 - 480);
});

teste('uma batida só: dia em aberto, total 0', () => {
  const r = Calc.calcularDia({ batidas: ['08:00'] }, '2026-07-22');
  assert.strictEqual(r.totalMin, 0);
  assert.strictEqual(r.aberto, true);
  assert.strictEqual(r.inconsistente, true);
});

teste('fim de semana: meta 0, tudo trabalhado vira extra', () => {
  const sab = Calc.calcularDia({ batidas: ['09:00', '11:00'] }, '2026-07-25');
  assert.strictEqual(sab.metaMin, 0);
  assert.strictEqual(sab.totalMin, 120);
  assert.strictEqual(sab.saldoMin, 120);
  const dom = Calc.calcularDia(undefined, '2026-07-26');
  assert.strictEqual(dom.metaMin, 0);
  assert.strictEqual(dom.saldoMin, 0);
});

teste('feriado (e demais tipos especiais) em dia útil: meta 0', () => {
  const fer = Calc.calcularDia({ batidas: [], tipo: 'feriado' }, '2026-07-22');
  assert.strictEqual(fer.metaMin, 0);
  assert.strictEqual(fer.saldoMin, 0);
  ['ferias', 'atestado', 'abono'].forEach((tipo) => {
    const r = Calc.calcularDia({ batidas: [], tipo }, '2026-07-23');
    assert.strictEqual(r.metaMin, 0, 'tipo ' + tipo + ' deve zerar meta');
  });
  // feriado com trabalho: tudo é extra
  const trab = Calc.calcularDia({ batidas: ['10:00', '12:00'], tipo: 'feriado' }, '2026-07-22');
  assert.strictEqual(trab.saldoMin, 120);
});

teste('tipo DESCONHECIDO não zera meta (mesma whitelist do gerador Node)', () => {
  // Fora da whitelist [feriado, ferias, atestado, abono] => trata como normal.
  ['Feriado', 'FERIADO', 'folga', 'ferias ', 'x'].forEach((tipo) => {
    const r = Calc.calcularDia({ batidas: [], tipo }, '2026-07-22'); // quarta
    assert.strictEqual(r.metaMin, 480, 'tipo "' + tipo + '" não deve zerar meta');
  });
  // Em fim de semana a meta continua 0 independentemente do tipo.
  const sab = Calc.calcularDia({ batidas: [], tipo: 'folga' }, '2026-07-25');
  assert.strictEqual(sab.metaMin, 0);
});

teste('batida com hora fora da faixa é rejeitada e marca inconsistente', () => {
  const r = Calc.calcularDia({ batidas: ['25:00', '26:00'] }, '2026-07-22');
  assert.strictEqual(r.totalMin, 0); // mesma resposta do gerador Node
  assert.strictEqual(r.inconsistente, true);
  assert.strictEqual(r.periodos.length, 0);
  assert.strictEqual(r.saldoMin, -480);
});

teste('batida malformada não vira NaN nem corrompe o período', () => {
  const r = Calc.calcularDia({ batidas: ['ab:cd', '12:00'] }, '2026-07-22');
  assert.strictEqual(r.totalMin, 0);
  assert.strictEqual(r.inconsistente, true);
  assert.ok(Number.isFinite(r.saldoMin), 'saldoMin não pode ser NaN');
  const r2 = Calc.calcularDia({ batidas: ['8h00', '12:00', '13:00', '17:00'] }, '2026-07-22');
  assert.strictEqual(r2.totalMin, 240); // só o par válido 13:00-17:00
  assert.strictEqual(r2.inconsistente, true);
  // fmtMin nunca imprime "NaN:NaN"
  assert.strictEqual(Calc.fmtMin(NaN), '00:00');
  // resumo do período também permanece finito
  const res = Calc.resumoPeriodo(
    { '2026-07-22': { batidas: ['ab:cd', '12:00'] } },
    '2026-07-20', '2026-07-24', '2026-07-24'
  );
  assert.ok(Number.isFinite(res.totalMin) && Number.isFinite(res.saldoMin));
});

teste('batidas fora de ordem: zera o par E marca inconsistente', () => {
  const r = Calc.calcularDia({ batidas: ['12:00', '08:00'] }, '2026-07-22');
  assert.strictEqual(r.totalMin, 0);
  assert.strictEqual(r.inconsistente, true); // igual ao gerador Node
  assert.strictEqual(r.aberto, false);
});

teste('diasUteis = dias com meta > 0 (feriado/atestado em dia útil não contam)', () => {
  // Semana 2026-07-20 (seg) a 2026-07-26 (dom): quarta feriado, quinta atestado.
  const dias = {
    '2026-07-22': { batidas: [], tipo: 'feriado' },
    '2026-07-23': { batidas: [], tipo: 'atestado' }
  };
  const r = Calc.resumoPeriodo(dias, '2026-07-20', '2026-07-26', '2026-07-26');
  assert.strictEqual(r.diasUteis, 3); // seg, ter, sex
  assert.strictEqual(r.metaMin, 3 * 480);
});

teste('semanaDe: segunda a domingo', () => {
  assert.deepStrictEqual(Calc.semanaDe('2026-07-22'), { inicioISO: '2026-07-20', fimISO: '2026-07-26' });
  assert.deepStrictEqual(Calc.semanaDe('2026-07-20'), { inicioISO: '2026-07-20', fimISO: '2026-07-26' }); // segunda
  assert.deepStrictEqual(Calc.semanaDe('2026-07-26'), { inicioISO: '2026-07-20', fimISO: '2026-07-26' }); // domingo
  assert.deepStrictEqual(Calc.semanaDe('2026-08-01'), { inicioISO: '2026-07-27', fimISO: '2026-08-02' }); // vira o mês
});

teste('semana com fim de semana trabalhado', () => {
  const dias = {
    '2026-07-20': { batidas: ['08:00', '12:00', '13:00', '17:00'] }, // 480
    '2026-07-21': { batidas: ['08:00', '12:00', '13:00', '17:00'] },
    '2026-07-22': { batidas: ['08:00', '12:00', '13:00', '17:00'] },
    '2026-07-23': { batidas: ['08:00', '12:00', '13:00', '17:00'] },
    '2026-07-24': { batidas: ['08:00', '12:00', '13:00', '17:00'] },
    '2026-07-25': { batidas: ['09:00', '11:00'] } // sábado: +120 extra
  };
  const sem = Calc.semanaDe('2026-07-22');
  const r = Calc.resumoPeriodo(dias, sem.inicioISO, sem.fimISO, '2026-07-26');
  assert.strictEqual(r.porDia.length, 7); // inclui domingo vazio
  assert.strictEqual(r.metaMin, 5 * 480);
  assert.strictEqual(r.totalMin, 5 * 480 + 120);
  assert.strictEqual(r.saldoMin, 120);
  assert.strictEqual(r.diasUteis, 5);
  assert.strictEqual(r.diasTrabalhados, 6);
  assert.strictEqual(r.porDia[6].dataISO, '2026-07-26');
  assert.strictEqual(r.porDia[6].totalMin, 0);
});

teste('mês completo com saldo negativo', () => {
  // Julho/2026: 23 dias úteis (fins de semana: 4,5,11,12,18,19,25,26).
  const dias = {};
  for (let d = 1; d <= 31; d++) {
    const iso = '2026-07-' + String(d).padStart(2, '0');
    if (Calc.ehDiaUtil(iso)) dias[iso] = { batidas: ['08:00', '12:00', '13:00', '17:00'] };
  }
  delete dias['2026-07-10']; // falta injustificada: -480
  const r = Calc.resumoPeriodo(dias, '2026-07-01', '2026-07-31', '2026-07-31');
  assert.strictEqual(r.porDia.length, 31);
  assert.strictEqual(r.diasUteis, 23);
  assert.strictEqual(r.metaMin, 23 * 480);
  assert.strictEqual(r.totalMin, 22 * 480);
  assert.strictEqual(r.saldoMin, -480);
  assert.strictEqual(r.diasTrabalhados, 22);
});

teste('mês completo com saldo positivo', () => {
  const dias = {};
  for (let d = 1; d <= 31; d++) {
    const iso = '2026-07-' + String(d).padStart(2, '0');
    if (Calc.ehDiaUtil(iso)) dias[iso] = { batidas: ['08:00', '12:00', '13:00', '17:00'] };
  }
  dias['2026-07-04'] = { batidas: ['09:00', '12:00'] }; // sábado: +180
  dias['2026-07-22'] = { batidas: ['08:00', '12:00', '13:00', '18:30'] }; // +90
  const r = Calc.resumoPeriodo(dias, '2026-07-01', '2026-07-31', '2026-07-31');
  assert.strictEqual(r.metaMin, 23 * 480);
  assert.strictEqual(r.saldoMin, 180 + 90);
  assert.strictEqual(r.diasTrabalhados, 24);
});

teste('mês corrente: dias futuros não contam meta', () => {
  const dias = {
    '2026-07-01': { batidas: ['08:00', '12:00', '13:00', '17:00'] },
    '2026-07-02': { batidas: ['08:00', '12:00', '13:00', '17:00'] }
  };
  // "hoje" = 2026-07-02 (quinta); 03..31 são futuros e não geram meta.
  const r = Calc.resumoPeriodo(dias, '2026-07-01', '2026-07-31', '2026-07-02');
  assert.strictEqual(r.porDia.length, 31); // todos os dias entram na lista
  assert.strictEqual(r.metaMin, 2 * 480);
  assert.strictEqual(r.saldoMin, 0);
  assert.strictEqual(r.diasUteis, 2);
  const dia03 = r.porDia.find((x) => x.dataISO === '2026-07-03');
  assert.strictEqual(dia03.futuro, true);
  assert.strictEqual(dia03.metaMin, 0);
});

teste('dia vazio (sem registro) em dia útil conta meta cheia', () => {
  const r = Calc.resumoPeriodo({}, '2026-07-22', '2026-07-22', '2026-07-31');
  assert.strictEqual(r.metaMin, 480);
  assert.strictEqual(r.saldoMin, -480);
  assert.strictEqual(r.porDia[0].batidas.length, 0);
});

teste('fmtMin e fmtSaldo (inclusive -0:xx)', () => {
  assert.strictEqual(Calc.fmtMin(486), '08:06');
  assert.strictEqual(Calc.fmtMin(0), '00:00');
  assert.strictEqual(Calc.fmtMin(65), '01:05');
  assert.strictEqual(Calc.fmtMin(-90), '01:30'); // fmtMin é magnitude
  assert.strictEqual(Calc.fmtSaldo(6), '+00:06');
  assert.strictEqual(Calc.fmtSaldo(-25), '-00:25'); // saldo negativo menor que 1h
  assert.strictEqual(Calc.fmtSaldo(-480), '-08:00');
  assert.strictEqual(Calc.fmtSaldo(0), '+00:00');
  assert.strictEqual(Calc.fmtSaldo(-1), '-00:01');
});

teste('hojeISO devolve data ISO no formato AAAA-MM-DD', () => {
  assert.match(Calc.hojeISO(), /^\d{4}-\d{2}-\d{2}$/);
});

/* ==================================================================
 * Contrato financeiro (meta do mês + quanto cobrar)
 * 2026-07 tem 23 dias úteis (seg-sex) -> meta 23 x 480 = 11040 min = 184 h.
 * ================================================================== */

teste('diasUteisNoMes conta apenas seg-sex', () => {
  assert.strictEqual(Calc.diasUteisNoMes(2026, 7), 23);
  assert.strictEqual(Calc.diasUteisNoMes(2026, 2), 20); // fev/2026
  assert.strictEqual(Calc.diasUteisNoMes(2026, 8), 21);
});

teste('jornada semanal define a meta diária (40h -> 480 min)', () => {
  assert.strictEqual(Calc.metaDiaMin({ jornadaSemanalH: 40 }), 480);
  assert.strictEqual(Calc.metaDiaMin({ jornadaSemanalH: 44 }), 528);
  assert.strictEqual(Calc.metaDiaMin({ jornadaSemanalH: 30 }), 360);
});

teste('baseMesMin: auto usa dias úteis x jornada diária; fixo usa baseHoras', () => {
  const auto = { valorMensal: 4500, jornadaSemanalH: 40, baseModo: 'auto' };
  assert.strictEqual(Calc.baseMesMin(2026, 7, auto), 23 * 480);
  const fixo = { valorMensal: 4500, baseModo: 'fixo', baseHoras: 200 };
  assert.strictEqual(Calc.baseMesMin(2026, 7, fixo), 200 * 60);
});

teste('valor da hora = valor mensal / horas-base do mês', () => {
  const c = Calc.normalizarContrato({ valorMensal: 4500, jornadaSemanalH: 40, baseModo: 'auto' });
  const base = Calc.baseMesMin(2026, 7, c); // 11040 min = 184 h
  const f = Calc.calcularValores(base, base, c);
  assert.strictEqual(Math.round(f.valorHora * 100) / 100, 24.46); // 4500/184
  assert.strictEqual(f.extraMin, 0);
  assert.strictEqual(f.faltaMin, 0);
  assert.strictEqual(f.total, 4500); // bateu a meta exata: só o fixo
});

teste('hora extra: o que passa da meta soma ao valor fixo', () => {
  const c = Calc.normalizarContrato({ valorMensal: 4500, jornadaSemanalH: 40, baseModo: 'auto' });
  const base = Calc.baseMesMin(2026, 7, c);
  const f = Calc.calcularValores(base + 600, base, c); // +10h
  assert.strictEqual(f.extraMin, 600);
  assert.strictEqual(f.faltaMin, 0);
  assert.strictEqual(Math.round(f.valorExtra * 100) / 100, 244.57); // 10 x 24,4565…
  assert.strictEqual(Math.round(f.total * 100) / 100, 4744.57);
});

teste('multiplicador de hora extra (1,5 = +50%)', () => {
  const c = Calc.normalizarContrato({ valorMensal: 4500, baseModo: 'fixo', baseHoras: 180, multiplicadorExtra: 1.5 });
  const f = Calc.calcularValores(180 * 60 + 600, 180 * 60, c); // hora = 25,00
  assert.strictEqual(f.valorHora, 25);
  assert.strictEqual(f.valorExtra, 10 * 25 * 1.5); // 375
  assert.strictEqual(f.total, 4875);
});

teste('horas faltantes: sem desconto por padrão, com desconto se ligado', () => {
  const semDesc = Calc.normalizarContrato({ valorMensal: 4500, baseModo: 'fixo', baseHoras: 180 });
  const f1 = Calc.calcularValores(180 * 60 - 600, 180 * 60, semDesc);
  assert.strictEqual(f1.faltaMin, 600);
  assert.strictEqual(f1.desconto, 0);
  assert.strictEqual(f1.total, 4500); // valor fechado é mantido

  const comDesc = Calc.normalizarContrato({ valorMensal: 4500, baseModo: 'fixo', baseHoras: 180, descontarFalta: true });
  const f2 = Calc.calcularValores(180 * 60 - 600, 180 * 60, comDesc);
  assert.strictEqual(f2.desconto, 250); // 10h x 25
  assert.strictEqual(f2.total, 4250);
});

teste('contrato inválido cai no padrão (nunca NaN, nunca divide por zero)', () => {
  const c = Calc.normalizarContrato({ valorMensal: 'abc', jornadaSemanalH: 0, multiplicadorExtra: -3, baseHoras: 0 });
  assert.strictEqual(c.valorMensal, 4500);
  assert.strictEqual(c.jornadaSemanalH, 40);
  assert.strictEqual(c.multiplicadorExtra, 1);
  assert.strictEqual(c.baseHoras, 200);
  const f = Calc.calcularValores(NaN, 0, c);
  assert.strictEqual(f.valorHora, 0);
  assert.strictEqual(f.total, 4500);
  assert.ok(isFinite(f.progresso));
});

teste('valorMensal aceita string "4.500,00" via normalização do app', () => {
  const c = Calc.normalizarContrato({ valorMensal: '5000,50' });
  assert.strictEqual(c.valorMensal, 5000.5);
});

teste('fmtBRL formata em real com milhar e centavos', () => {
  assert.strictEqual(Calc.fmtBRL(4500), 'R$ 4.500,00');
  assert.strictEqual(Calc.fmtBRL(24.456521739), 'R$ 24,46');
  assert.strictEqual(Calc.fmtBRL(0), 'R$ 0,00');
  assert.strictEqual(Calc.fmtBRL(1234567.891), 'R$ 1.234.567,89');
  assert.strictEqual(Calc.fmtBRL(NaN), 'R$ 0,00');
});

teste('setContrato muda a meta diária usada por calcularDia/resumoPeriodo', () => {
  const original = Calc.getContrato();
  try {
    Calc.setContrato({ valorMensal: 4500, jornadaSemanalH: 30 }); // 6h/dia
    const r = Calc.calcularDia({ batidas: ['09:00', '15:00'] }, '2026-07-22');
    assert.strictEqual(r.metaMin, 360);
    assert.strictEqual(r.saldoMin, 0);
    const res = Calc.resumoPeriodo({}, '2026-07-20', '2026-07-24', '2026-07-31');
    assert.strictEqual(res.metaMin, 5 * 360);
  } finally {
    Calc.setContrato(original); // não vaza estado para os outros testes
  }
});

teste('meta diária explícita tem precedência sobre o contrato ativo', () => {
  const r = Calc.calcularDia({ batidas: ['08:00', '12:00'] }, '2026-07-22', 240);
  assert.strictEqual(r.metaMin, 240);
  assert.strictEqual(r.saldoMin, 0);
});

console.log('');
console.log('Total: ' + (passaram + falharam) + ' | Passaram: ' + passaram + ' | Falharam: ' + falharam);
if (falharam > 0) process.exit(1);
console.log('Todos os testes passaram.');
