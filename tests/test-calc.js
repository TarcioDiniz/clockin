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

console.log('');
console.log('Total: ' + (passaram + falharam) + ' | Passaram: ' + passaram + ' | Falharam: ' + falharam);
if (falharam > 0) process.exit(1);
console.log('Todos os testes passaram.');
