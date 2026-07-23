/* Validação E2E (Playwright/Chromium) — não faz parte do app publicado. */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8123';
const TZ = 'America/Sao_Paulo';

function horaSP(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  });
  const s = fmt.format(d);
  return s === '24' ? '00' : s;
}
function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

(async () => {
  const browser = await chromium.launch();
  const erros = [];
  let falhas = 0;
  const ok = (cond, nome, extra) => {
    console.log((cond ? '  ok  ' : '  FALHOU  ') + nome + (extra ? ' — ' + extra : ''));
    if (!cond) falhas++;
  };

  const iso = hojeSP();
  const mes = iso.slice(0, 7);
  const entrada = horaSP(-180); // 3h atrás
  const saida = horaSP(-30);    // saiu para o almoço há 30 min

  /* ============ CENÁRIO 1: modo demo, card de intervalo + modal ============ */
  console.log('\n[1] Modo demo — card de intervalo e modal de confirmação');
  const ctx1 = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['notifications']
  });
  const pg1 = await ctx1.newPage();
  pg1.on('console', m => { if (m.type() === 'error') erros.push('[1] ' + m.text()); });
  pg1.on('pageerror', e => erros.push('[1] pageerror: ' + e.message));

  await pg1.addInitScript(({ mes, iso, entrada, saida }) => {
    localStorage.setItem('ponto.config', JSON.stringify({ owner: '', repo: '', token: '', demo: true }));
    localStorage.setItem('ponto.cache.' + mes, JSON.stringify({
      dias: { [iso]: { batidas: [entrada, saida], obs: '', tipo: 'normal' } }, sha: null
    }));
  }, { mes, iso, entrada, saida });

  await pg1.goto(BASE + '/index.html');
  await pg1.waitForTimeout(800);

  const cardVisivel = await pg1.locator('#card-intervalo').isVisible();
  ok(cardVisivel, 'card "Intervalo em andamento" visível com 2 batidas');
  const msgInt = await pg1.locator('#int-msg').textContent();
  ok(/Faltam \d+ min para completar o intervalo mínimo de 1h/.test(msgInt || ''),
    'mensagem "Faltam X min..." correta', JSON.stringify(msgInt));
  const tempoInt = await pg1.locator('#int-tempo').textContent();
  ok(/00:(29|30|31)/.test(tempoInt || ''), 'tempo decorrido ~30 min', tempoInt);

  // 3ª batida com intervalo curto -> modal de confirmação
  await pg1.click('#btn-bater');
  await pg1.waitForTimeout(300);
  const modalVisivel = await pg1.locator('#modal-intervalo').isVisible();
  ok(modalVisivel, 'modal de confirmação aparece na 3ª batida com intervalo < 60 min');
  const txtModal = await pg1.locator('#modal-intervalo-texto').textContent();
  ok(/Seu intervalo tem só \d+ min — o mínimo é 1h/.test(txtModal || ''),
    'texto do modal correto', JSON.stringify(txtModal));

  await pg1.screenshot({ path: 'screenshot-intervalo.png', fullPage: false });
  console.log('  screenshot-intervalo.png capturado (card + modal)');

  // "Voltar" não registra
  await pg1.click('#btn-intervalo-voltar');
  await pg1.waitForTimeout(200);
  let nBatidas = await pg1.locator('#lista-batidas-hoje li').count();
  ok(nBatidas === 2, '"Voltar" não registra a batida (continua 2)', String(nBatidas));

  // "Registrar assim mesmo" registra a 3ª
  await pg1.click('#btn-bater');
  await pg1.waitForTimeout(200);
  await pg1.click('#btn-intervalo-confirmar');
  await pg1.waitForTimeout(500);
  nBatidas = await pg1.locator('#lista-batidas-hoje li').count();
  ok(nBatidas === 3, '"Registrar assim mesmo" registra a 3ª batida', String(nBatidas));
  const cardSumiu = !(await pg1.locator('#card-intervalo').isVisible());
  ok(cardSumiu, 'card de intervalo some após a 3ª batida');
  const bannerOculto1 = !(await pg1.locator('#banner-pendentes').isVisible());
  ok(bannerOculto1, 'banner de pendências NÃO aparece em modo demo');
  await ctx1.close();

  /* ============ CENÁRIO 1b: intervalo cumprido (card verde) ============ */
  console.log('\n[1b] Modo demo — intervalo >= 1h vira verde e não pede confirmação');
  const ctx1b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg1b = await ctx1b.newPage();
  pg1b.on('console', m => { if (m.type() === 'error') erros.push('[1b] ' + m.text()); });
  pg1b.on('pageerror', e => erros.push('[1b] pageerror: ' + e.message));
  const saida70 = horaSP(-70);
  await pg1b.addInitScript(({ mes, iso, entrada, saida70 }) => {
    localStorage.setItem('ponto.config', JSON.stringify({ demo: true }));
    localStorage.setItem('ponto.cache.' + mes, JSON.stringify({
      dias: { [iso]: { batidas: [entrada, saida70], obs: '', tipo: 'normal' } }, sha: null
    }));
  }, { mes, iso, entrada, saida70 });
  await pg1b.goto(BASE + '/index.html');
  await pg1b.waitForTimeout(600);
  const completo = await pg1b.locator('#card-intervalo.completo').isVisible();
  ok(completo, 'card verde (classe .completo) com 70 min de intervalo');
  const tituloOk = /Intervalo mínimo cumprido ✓/.test(await pg1b.locator('#int-titulo').textContent() || '');
  ok(tituloOk, 'texto "Intervalo mínimo cumprido ✓"');
  await pg1b.click('#btn-bater');
  await pg1b.waitForTimeout(400);
  const semModal = !(await pg1b.locator('#modal-intervalo').isVisible());
  ok(semModal, 'sem modal quando intervalo >= 60 min (3ª batida direta)');
  const n1b = await pg1b.locator('#lista-batidas-hoje li').count();
  ok(n1b === 3, '3ª batida registrada direto', String(n1b));
  await pg1b.screenshot({ path: 'screenshot-intervalo-verde.png' });
  await ctx1b.close();

  /* ============ CENÁRIO 2: não-demo com token falso -> pendências ============ */
  console.log('\n[2] Não-demo com token falso — banner laranja + toast "gravada no celular"');
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg2 = await ctx2.newPage();
  pg2.on('console', m => { if (m.type() === 'error') erros.push('[2] ' + m.text()); });
  pg2.on('pageerror', e => erros.push('[2] pageerror: ' + e.message));

  // Responde 401 como o GitHub real faria com token inválido.
  await pg2.route('https://api.github.com/**', route => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'Bad credentials' })
  }));

  await pg2.addInitScript(() => {
    localStorage.setItem('ponto.config', JSON.stringify({
      owner: 'usuario-teste', repo: 'ponto-teste', token: 'github_pat_FALSO123', demo: false
    }));
  });
  await pg2.goto(BASE + '/index.html');
  await pg2.waitForTimeout(800);

  await pg2.click('#btn-bater');
  await pg2.waitForTimeout(1500);

  const toastTxt = (await pg2.locator('#toast').textContent()) || '';
  ok(/Batida gravada no celular\. Envio ao GitHub falhou:/.test(toastTxt),
    'toast deixa claro que nada foi perdido', JSON.stringify(toastTxt));
  ok(/Reenvie pelo aviso na tela/.test(toastTxt), 'toast orienta a reenviar pelo aviso');

  const bannerVisivel = await pg2.locator('#banner-pendentes').isVisible();
  ok(bannerVisivel, 'banner laranja de pendências visível');
  const bannerTxt = (await pg2.locator('#banner-pendentes').textContent()) || '';
  ok(/1 registro\(s\) no celular aguardando envio ao GitHub/.test(bannerTxt),
    'banner mostra a contagem', JSON.stringify(bannerTxt));
  ok(/Motivo: .*(401|Token)/.test(bannerTxt), 'banner mostra o motivo (401/token)', JSON.stringify(bannerTxt));
  ok(/Toque para reenviar/.test(bannerTxt), 'banner convida a reenviar');

  const nLocal = await pg2.locator('#lista-batidas-hoje li').count();
  ok(nLocal === 1, 'batida aparece na lista local mesmo com falha de envio', String(nLocal));

  await pg2.screenshot({ path: 'screenshot-pendentes.png' });

  // Toque no banner com o "GitHub" ainda com 401 -> continua pendente, toast de falha
  await pg2.click('#banner-pendentes');
  await pg2.waitForTimeout(1200);
  const aindaVisivel = await pg2.locator('#banner-pendentes').isVisible();
  ok(aindaVisivel, 'banner permanece após reenvio falhar (401 de novo)');

  // Agora o "GitHub" volta a funcionar: reenvio deve limpar a fila.
  await pg2.unroute('https://api.github.com/**');
  let putRecebido = null;
  await pg2.route('https://api.github.com/**', route => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) });
    }
    if (req.method() === 'PUT') {
      putRecebido = JSON.parse(req.postData());
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ content: { sha: 'abc123' } })
      });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await pg2.click('#banner-pendentes');
  await pg2.waitForTimeout(1500);
  const bannerSumiu = !(await pg2.locator('#banner-pendentes').isVisible());
  ok(bannerSumiu, 'banner some após reenvio bem-sucedido');
  ok(!!putRecebido, 'PUT chegou ao "GitHub" no reenvio');
  const toastOk = (await pg2.locator('#toast').textContent()) || '';
  ok(/enviado\(s\) ao GitHub com sucesso/.test(toastOk), 'toast de sucesso do reenvio', JSON.stringify(toastOk));
  const semErro = await pg2.evaluate(() => window.PontoStorage.ultimoErroSync());
  ok(semErro === null, 'ultimoErroSync limpo após sincronização OK');
  await ctx2.close();

  /* ============ CENÁRIO 3: Testar conexão mostra status HTTP ============ */
  console.log('\n[3] Config — Testar conexão com token falso mostra status HTTP');
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg3 = await ctx3.newPage();
  pg3.on('console', m => { if (m.type() === 'error') erros.push('[3] ' + m.text()); });
  pg3.on('pageerror', e => erros.push('[3] pageerror: ' + e.message));
  await pg3.route('https://api.github.com/**', route => route.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Bad credentials' })
  }));
  await pg3.goto(BASE + '/index.html');
  await pg3.waitForTimeout(500);
  await pg3.click('[data-aba="config"]');
  await pg3.fill('#cfg-owner', ' usuario-teste ');           // espaços de propósito
  await pg3.fill('#cfg-repo', 'ponto-teste');
  await pg3.fill('#cfg-token', '  github_pat_FALSO123 \n');  // espaço invisível colado
  await pg3.click('#btn-testar');
  await pg3.waitForTimeout(1200);
  const toast3 = (await pg3.locator('#toast').textContent()) || '';
  ok(/HTTP 401/.test(toast3), 'teste de conexão mostra o status HTTP na falha', JSON.stringify(toast3));
  const cfgSalva = await pg3.evaluate(() => window.PontoStorage.getConfig());
  ok(cfgSalva.token === 'github_pat_FALSO123' && cfgSalva.owner === 'usuario-teste',
    'token/owner salvos com .trim()', JSON.stringify({ owner: cfgSalva.owner, token: cfgSalva.token }));

  // Toggle de lembrete existe e vem ligado por padrão
  const lembrete = await pg3.locator('#cfg-lembrete').isChecked();
  ok(lembrete, 'toggle "Lembrar de bater o ponto..." ligado por padrão');
  await ctx3.close();

  /* ============ CENÁRIO 4: SW + manifest ============ */
  console.log('\n[4] Service worker e manifest');
  const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg4 = await ctx4.newPage();
  pg4.on('console', m => { if (m.type() === 'error') erros.push('[4] ' + m.text()); });
  await pg4.goto(BASE + '/index.html');
  await pg4.waitForTimeout(1500);
  const swOk = await pg4.evaluate(() =>
    navigator.serviceWorker.getRegistration().then(r => !!r).catch(() => false));
  ok(swOk, 'service worker registrado');
  const manifestHref = await pg4.evaluate(() =>
    document.querySelector('link[rel="manifest"]').getAttribute('href'));
  ok(manifestHref === 'manifest.json?v=2', 'manifest linkado com ?v=2', manifestHref);
  const scripts = await pg4.evaluate(() =>
    Array.from(document.querySelectorAll('script[src^="js/"]')).map(s => s.getAttribute('src')));
  ok(scripts.every(s => s.endsWith('?v=2')) && scripts.length === 3,
    'scripts js/ com ?v=2', JSON.stringify(scripts));
  await ctx4.close();

  await browser.close();

  console.log('\nErros de console/página:', erros.length ? erros : 'nenhum');
  // Ignora erros esperados de rede/401 (o cenário simula falhas do GitHub).
  const errosReais = erros.filter(e =>
    !/401|Failed to load resource|Bad credentials|net::|Failed to fetch|the server responded with a status/.test(e));
  console.log('Erros de console NÃO esperados:', errosReais.length ? errosReais : 'nenhum');

  if (falhas || errosReais.length) {
    console.log('\nRESULTADO: FALHOU (' + falhas + ' verificações, ' + errosReais.length + ' erros de console)');
    process.exit(1);
  }
  console.log('\nRESULTADO: TUDO OK');
})().catch(e => { console.error(e); process.exit(1); });
