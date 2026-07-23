/**
 * ponto-app/js/storage.js
 * ------------------------------------------------------------------
 * Camada de persistência do sistema "Ponto".
 * Define window.PontoStorage (sem módulos ES, sem framework).
 *
 * Modelo de dados: um arquivo JSON por mês no repositório GitHub,
 * caminho registros/AAAA-MM.json, no formato:
 *   { "dias": { "2026-07-22": { "batidas": [...], "obs": "", "tipo": "normal" } } }
 *
 * Modos de operação:
 *  - GitHub (config com owner/repo/token): lê/grava via Contents API,
 *    mantendo cache local como fallback offline.
 *  - Demo (config.demo=true) ou sem token: persiste apenas em
 *    localStorage ("ponto.cache.AAAA-MM"), mesma API, sem rede.
 *
 * Todas as datas/horas usam o fuso America/Sao_Paulo, obtidas por
 * Intl.DateTimeFormat (nunca new Date() "cru" para componentes locais).
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Constantes
  // ---------------------------------------------------------------
  var FUSO = 'America/Sao_Paulo';
  var CHAVE_CONFIG = 'ponto.config';
  var CHAVE_PENDENTES = 'ponto.pendentes';
  var CHAVE_ULTIMO_ERRO = 'ponto.ultimoErro';
  var PREFIXO_CACHE = 'ponto.cache.'; // + AAAA-MM
  var API_BASE = 'https://api.github.com';
  var MAX_TENTATIVAS = 3; // tentativas em conflito 409/422

  // Evita reentrância ao sincronizar pendências após um sucesso.
  var sincronizando = false;

  // ---------------------------------------------------------------
  // Utilidades de data/hora no fuso America/Sao_Paulo
  // ---------------------------------------------------------------

  /**
   * Retorna os componentes de data/hora ATUAIS no fuso de São Paulo.
   * Usa Intl.DateTimeFormat com timeZone para nunca depender do fuso
   * do navegador/dispositivo.
   * @returns {{ano:string, mes:string, dia:string, hora:string, minuto:string}}
   */
  function agoraSP() {
    var fmt = new Intl.DateTimeFormat('pt-BR', {
      timeZone: FUSO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    var partes = fmt.formatToParts(new Date());
    var comp = {};
    for (var i = 0; i < partes.length; i++) {
      comp[partes[i].type] = partes[i].value;
    }
    // Alguns ambientes retornam "24" para meia-noite com hour12:false.
    var hora = comp.hour === '24' ? '00' : comp.hour;
    return {
      ano: comp.year,
      mes: comp.month,
      dia: comp.day,
      hora: hora,
      minuto: comp.minute
    };
  }

  /** Data de hoje em ISO AAAA-MM-DD no fuso de São Paulo. */
  function hojeISO() {
    var a = agoraSP();
    return a.ano + '-' + a.mes + '-' + a.dia;
  }

  /** Hora atual "HH:MM" (24h) no fuso de São Paulo. */
  function horaAgoraHHMM() {
    var a = agoraSP();
    return a.hora + ':' + a.minuto;
  }

  /** Normaliza ano/mes em chave "AAAA-MM" (mes pode ser 1..12 ou "07"). */
  function chaveMes(ano, mes) {
    var m = String(mes);
    if (m.length < 2) m = '0' + m;
    return String(ano) + '-' + m;
  }

  /** Extrai "AAAA-MM" de uma data ISO "AAAA-MM-DD". */
  function mesDaData(dataISO) {
    return String(dataISO).slice(0, 7);
  }

  /** Valida formato "HH:MM" 24h. */
  function horaValida(hhmm) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(hhmm));
  }

  // ---------------------------------------------------------------
  // Base64 UTF-8 seguro (a Contents API exige conteúdo em base64)
  // ---------------------------------------------------------------

  /**
   * Codifica uma string (UTF-8) em base64 sem corromper acentos.
   * TextEncoder -> bytes -> btoa em blocos (evita estouro de pilha).
   */
  function utf8ParaBase64(texto) {
    var bytes = new TextEncoder().encode(texto);
    var binario = '';
    var BLOCO = 0x8000; // 32k bytes por chamada de fromCharCode
    for (var i = 0; i < bytes.length; i += BLOCO) {
      binario += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCO));
    }
    return btoa(binario);
  }

  /**
   * Decodifica base64 (possivelmente com quebras de linha, como a API
   * do GitHub devolve) para string UTF-8.
   */
  function base64ParaUtf8(b64) {
    var limpo = String(b64).replace(/\s/g, '');
    var binario = atob(limpo);
    var bytes = new Uint8Array(binario.length);
    for (var i = 0; i < binario.length; i++) {
      bytes[i] = binario.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  // ---------------------------------------------------------------
  // Configuração (localStorage "ponto.config")
  // ---------------------------------------------------------------

  /**
   * Lê a configuração salva. Sempre retorna um objeto com as chaves
   * esperadas (valores vazios por padrão).
   * @returns {{owner:string, repo:string, token:string, demo:boolean}}
   */
  function getConfig() {
    var padrao = { owner: '', repo: '', token: '', demo: false };
    try {
      var bruto = localStorage.getItem(CHAVE_CONFIG);
      if (!bruto) return padrao;
      var cfg = JSON.parse(bruto);
      return {
        owner: cfg.owner || '',
        repo: cfg.repo || '',
        token: cfg.token || '',
        demo: !!cfg.demo
      };
    } catch (e) {
      return padrao;
    }
  }

  /**
   * Grava a configuração (mescla com a existente).
   * @param {{owner?:string, repo?:string, token?:string, demo?:boolean}} nova
   */
  function setConfig(nova) {
    var atual = getConfig();
    // .trim() sempre: espaço/quebra de linha invisível colado junto com o
    // token (colar no celular) é causa clássica de 401 difícil de enxergar.
    var cfg = {
      owner: String(nova.owner !== undefined ? nova.owner : atual.owner).trim(),
      repo: String(nova.repo !== undefined ? nova.repo : atual.repo).trim(),
      token: String(nova.token !== undefined ? nova.token : atual.token).trim(),
      demo: nova.demo !== undefined ? !!nova.demo : atual.demo
    };
    localStorage.setItem(CHAVE_CONFIG, JSON.stringify(cfg));
    return cfg;
  }

  /** true quando devemos operar somente com localStorage (sem rede). */
  function modoLocal(cfg) {
    cfg = cfg || getConfig();
    return cfg.demo || !cfg.token || !cfg.owner || !cfg.repo;
  }

  // ---------------------------------------------------------------
  // Cache local por mês ("ponto.cache.AAAA-MM")
  // ---------------------------------------------------------------

  /** Lê o cache local do mês. Retorna {dias, sha} (dias = {} se vazio). */
  function lerCache(chave) {
    try {
      var bruto = localStorage.getItem(PREFIXO_CACHE + chave);
      if (!bruto) return { dias: {}, sha: null };
      var obj = JSON.parse(bruto);
      return { dias: obj.dias || {}, sha: obj.sha || null };
    } catch (e) {
      return { dias: {}, sha: null };
    }
  }

  /** Grava o cache local do mês. */
  function gravarCache(chave, dias, sha) {
    localStorage.setItem(
      PREFIXO_CACHE + chave,
      JSON.stringify({ dias: dias || {}, sha: sha || null })
    );
  }

  // ---------------------------------------------------------------
  // Fila de pendências offline ("ponto.pendentes")
  // Cada item: { dataISO, dia, mensagem, ts }
  // ---------------------------------------------------------------

  function lerPendentes() {
    try {
      var bruto = localStorage.getItem(CHAVE_PENDENTES);
      var lista = bruto ? JSON.parse(bruto) : [];
      return Array.isArray(lista) ? lista : [];
    } catch (e) {
      return [];
    }
  }

  function gravarPendentes(lista) {
    localStorage.setItem(CHAVE_PENDENTES, JSON.stringify(lista || []));
  }

  /**
   * Mescla a versão remota de um dia com a versão local pendente:
   * união das batidas (sem duplicatas, ordenadas); obs/tipo locais
   * prevalecem quando informados. Nenhuma batida confirmada é perdida.
   */
  function mesclarDia(remoto, local) {
    var a = normalizarDia(remoto || {});
    var b = normalizarDia(local || {});
    var vistos = {};
    var batidas = [];
    a.batidas.concat(b.batidas).forEach(function (h) {
      if (!vistos[h]) {
        vistos[h] = true;
        batidas.push(h);
      }
    });
    batidas.sort();
    return {
      batidas: batidas,
      obs: b.obs || a.obs,
      tipo: (b.tipo && b.tipo !== 'normal') ? b.tipo : a.tipo
    };
  }

  /** Pendências que pertencem ao mês "AAAA-MM". */
  function pendentesDoMes(chave) {
    return lerPendentes().filter(function (p) {
      return mesDaData(p.dataISO) === chave;
    });
  }

  /**
   * Aplica (mescla) as pendências do mês por cima de um mapa de dias.
   * Garante que registros ainda não confirmados no remoto nunca sumam
   * da tela nem sejam apagados do cache por um GET bem-sucedido.
   */
  function aplicarPendencias(chave, dias) {
    var pend = pendentesDoMes(chave);
    for (var i = 0; i < pend.length; i++) {
      dias[pend[i].dataISO] = mesclarDia(dias[pend[i].dataISO], pend[i].dia);
    }
    return dias;
  }

  /** Remove a pendência de um dia (após confirmação de gravação no remoto). */
  function removerPendente(dataISO) {
    gravarPendentes(lerPendentes().filter(function (p) {
      return p.dataISO !== dataISO;
    }));
  }

  /** Enfileira (ou substitui) a pendência do dia — vale a versão mais recente. */
  function enfileirarPendente(dataISO, dia, mensagem) {
    var lista = lerPendentes();
    var achou = false;
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].dataISO === dataISO) {
        lista[i] = { dataISO: dataISO, dia: dia, mensagem: mensagem, ts: Date.now() };
        achou = true;
        break;
      }
    }
    if (!achou) {
      lista.push({ dataISO: dataISO, dia: dia, mensagem: mensagem, ts: Date.now() });
    }
    gravarPendentes(lista);
  }

  // ---------------------------------------------------------------
  // Diagnóstico de sincronização ("ponto.ultimoErro")
  // ---------------------------------------------------------------

  /** Quantidade de registros aguardando envio ao GitHub. */
  function contarPendentes() {
    return lerPendentes().length;
  }

  /** Persiste a última mensagem de erro de escrita (com timestamp). */
  function registrarUltimoErro(mensagem) {
    try {
      localStorage.setItem(CHAVE_ULTIMO_ERRO, JSON.stringify({
        mensagem: String(mensagem || 'Erro desconhecido'),
        ts: Date.now()
      }));
    } catch (e) { /* localStorage cheio/indisponível: ignora */ }
  }

  /** Limpa o registro de erro (chamado quando uma sincronização dá certo). */
  function limparUltimoErro() {
    try { localStorage.removeItem(CHAVE_ULTIMO_ERRO); } catch (e) { /* ignora */ }
  }

  /**
   * Última falha de escrita/sincronização registrada.
   * @returns {{mensagem:string, ts:number}|null}
   */
  function ultimoErroSync() {
    try {
      var bruto = localStorage.getItem(CHAVE_ULTIMO_ERRO);
      if (!bruto) return null;
      var obj = JSON.parse(bruto);
      if (!obj || !obj.mensagem) return null;
      return { mensagem: String(obj.mensagem), ts: obj.ts || 0 };
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------
  // GitHub Contents API
  // ---------------------------------------------------------------

  /** Monta a URL do arquivo do mês no repositório. */
  function urlArquivoMes(cfg, chave) {
    return (
      API_BASE +
      '/repos/' +
      encodeURIComponent(cfg.owner) +
      '/' +
      encodeURIComponent(cfg.repo) +
      '/contents/registros/' +
      chave +
      '.json'
    );
  }

  /** Cabeçalhos padrão para a API do GitHub. */
  function cabecalhos(cfg) {
    return {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /** Erro "amigável" com flag de rede para o chamador decidir o fallback. */
  function erroDeRede(original) {
    var e = new Error(
      'Sem conexão com a internet. O registro foi salvo localmente e será sincronizado depois.'
    );
    e.rede = true;
    e.causa = original;
    return e;
  }

  /** Converte status HTTP em erro claro em PT-BR. */
  function erroHttp(status, contexto) {
    var msg;
    if (status === 401) {
      msg = 'Token do GitHub inválido ou expirado (HTTP 401). Verifique o token nas configurações.';
    } else if (status === 403) {
      msg = 'Acesso negado pelo GitHub (HTTP 403). Verifique as permissões do token ou o limite de requisições.';
    } else if (status === 404) {
      msg = 'Repositório ou arquivo não encontrado (HTTP 404). Confira usuário/repositório nas configurações.';
    } else {
      msg = 'Erro do GitHub (' + status + ')' + (contexto ? ' ao ' + contexto : '') + '.';
    }
    var e = new Error(msg);
    e.status = status;
    return e;
  }

  /**
   * GET do arquivo do mês no GitHub.
   * @returns {Promise<{dias:Object, sha:string|null}>}
   *          404 (mês ainda sem arquivo) resolve com {dias:{}, sha:null}.
   */
  function githubGetMes(cfg, chave) {
    var url = urlArquivoMes(cfg, chave);
    return fetch(url, { headers: cabecalhos(cfg) })
      .catch(function (e) {
        throw erroDeRede(e);
      })
      .then(function (resp) {
        if (resp.status === 404) {
          // Mês novo: arquivo ainda não existe no repositório.
          return { dias: {}, sha: null };
        }
        if (resp.status === 401) throw erroHttp(401);
        if (!resp.ok) throw erroHttp(resp.status, 'carregar o mês ' + chave);
        return resp.json().then(function (json) {
          var dias = {};
          try {
            var conteudo = JSON.parse(base64ParaUtf8(json.content));
            dias = conteudo && conteudo.dias ? conteudo.dias : {};
          } catch (e) {
            // Arquivo corrompido/ilegível: trata como vazio, mas mantém o SHA
            // para que a próxima gravação o substitua.
            dias = {};
          }
          return { dias: dias, sha: json.sha || null };
        });
      });
  }

  /**
   * PUT do arquivo do mês no GitHub (cria ou atualiza).
   * @returns {Promise<string>} SHA novo do conteúdo gravado.
   */
  function githubPutMes(cfg, chave, dias, sha, mensagem) {
    var url = urlArquivoMes(cfg, chave);
    var corpo = {
      message: mensagem,
      content: utf8ParaBase64(JSON.stringify({ dias: dias }, null, 2))
    };
    if (sha) corpo.sha = sha; // sem SHA = criação de arquivo novo
    return fetch(url, {
      method: 'PUT',
      headers: cabecalhos(cfg),
      body: JSON.stringify(corpo)
    })
      .catch(function (e) {
        throw erroDeRede(e);
      })
      .then(function (resp) {
        if (resp.status === 401) throw erroHttp(401);
        if (resp.status === 409 || resp.status === 422) {
          // Conflito de SHA: outro cliente gravou antes. O chamador refaz o GET.
          var e = new Error('Conflito de versão ao salvar (o arquivo mudou no GitHub).');
          e.conflito = true;
          e.status = resp.status;
          throw e;
        }
        if (!resp.ok) throw erroHttp(resp.status, 'salvar o mês ' + chave);
        return resp.json().then(function (json) {
          return (json.content && json.content.sha) || null;
        });
      });
  }

  // ---------------------------------------------------------------
  // API pública: carregarMes
  // ---------------------------------------------------------------

  /**
   * Carrega os dias de um mês.
   * @param {number|string} ano  ex.: 2026
   * @param {number|string} mes  1..12
   * @returns {Promise<{dias:Object, sha:string|null}>}
   */
  function carregarMes(ano, mes) {
    var chave = chaveMes(ano, mes);
    var cfg = getConfig();

    // Modo demo / sem token: só localStorage.
    if (modoLocal(cfg)) {
      return Promise.resolve(lerCache(chave));
    }

    // Com token: busca no GitHub, MESCLA as pendências ainda não
    // sincronizadas por cima do conteúdo remoto (para não "sumir" com
    // registros feitos offline) e atualiza o cache local (fallback offline).
    return githubGetMes(cfg, chave)
      .then(function (res) {
        var dias = aplicarPendencias(chave, res.dias);
        gravarCache(chave, dias, res.sha);
        return { dias: dias, sha: res.sha };
      })
      .catch(function (e) {
        if (e && e.rede) {
          // Offline: serve o que houver no cache local (+ pendências).
          var c = lerCache(chave);
          return { dias: aplicarPendencias(chave, c.dias), sha: c.sha };
        }
        throw e;
      });
  }

  // ---------------------------------------------------------------
  // API pública: salvarDia
  // ---------------------------------------------------------------

  /**
   * Normaliza o objeto de um dia antes de gravar.
   * Garante batidas ordenadas e campos obrigatórios.
   */
  function normalizarDia(dia) {
    var d = {
      batidas: Array.isArray(dia.batidas) ? dia.batidas.slice() : [],
      obs: typeof dia.obs === 'string' ? dia.obs : '',
      tipo: dia.tipo || 'normal'
    };
    d.batidas.sort(); // "HH:MM" ordena corretamente como string
    return d;
  }

  /**
   * Salva (lê-modifica-grava) o registro de um dia no arquivo do mês.
   * Em conflito 409/422 refaz o GET e tenta novamente, até 3 tentativas.
   * Offline: grava no cache local e enfileira em "ponto.pendentes".
   *
   * @param {string} dataISO "AAAA-MM-DD"
   * @param {Object} dia     {batidas, obs, tipo}
   * @param {string} [mensagem] mensagem de commit opcional
   * @returns {Promise<Object>} o dia gravado (com flag pendente=true se ficou offline)
   */
  function salvarDia(dataISO, dia, mensagem) {
    var chave = mesDaData(dataISO);
    var cfg = getConfig();
    var diaLimpo = normalizarDia(dia);
    var msg = mensagem || 'ponto: atualiza ' + dataISO;

    // Sempre atualiza o cache local primeiro (fonte de verdade offline).
    var cache = lerCache(chave);
    cache.dias[dataISO] = diaLimpo;
    gravarCache(chave, cache.dias, cache.sha);

    // Modo demo / sem token: pronto, só localStorage.
    if (modoLocal(cfg)) {
      return Promise.resolve(diaLimpo);
    }

    // Com token: lê-modifica-grava no GitHub, com retry em conflito.
    function tentar(tentativa) {
      return githubGetMes(cfg, chave).then(function (res) {
        // Mescla por cima do que está no GitHub (não perde outros dias).
        res.dias[dataISO] = diaLimpo;
        return githubPutMes(cfg, chave, res.dias, res.sha, msg)
          .then(function (novoSha) {
            gravarCache(chave, res.dias, novoSha);
            // Gravação confirmada: a versão recém-salva do dia é a mais
            // recente — pendência antiga desse dia fica obsoleta.
            removerPendente(dataISO);
            limparUltimoErro();
            return diaLimpo;
          })
          .catch(function (e) {
            if (e && e.conflito && tentativa < MAX_TENTATIVAS) {
              // Conflito: outro cliente salvou antes; refaz GET e tenta de novo.
              return tentar(tentativa + 1);
            }
            throw e;
          });
      });
    }

    return tentar(1)
      .then(function (salvo) {
        // Sucesso online: aproveita para escoar pendências antigas.
        sincronizarPendentes().catch(function () { /* silencioso */ });
        return salvo;
      })
      .catch(function (e) {
        // QUALQUER falha de escrita (rede, 401/403, conflito 409/422 após as
        // tentativas...) mantém o registro na fila de pendências: o dado já
        // está no cache local e nunca deve desaparecer sem ser confirmado
        // no remoto — o próximo sync mescla e envia.
        enfileirarPendente(dataISO, diaLimpo, msg);
        registrarUltimoErro(e && e.message);
        if (e && e.rede) {
          var copia = normalizarDia(diaLimpo);
          copia.pendente = true;
          return copia;
        }
        throw e; // erros reais (401 etc.) sobem para a UI tratar
      });
  }

  // ---------------------------------------------------------------
  // API pública: baterPonto
  // ---------------------------------------------------------------

  /**
   * Registra uma batida de ponto no dia de HOJE (fuso America/Sao_Paulo).
   * @param {string} [horaHHMM] hora manual "HH:MM"; se omitida, usa agora.
   * @returns {Promise<Object>} o dia atualizado.
   */
  function baterPonto(horaHHMM) {
    var hora = horaHHMM || horaAgoraHHMM();
    if (!horaValida(hora)) {
      return Promise.reject(new Error('Hora inválida: use o formato HH:MM (24h).'));
    }
    var dataISO = hojeISO();
    var partes = dataISO.split('-'); // [AAAA, MM, DD]
    var chave = mesDaData(dataISO);

    return carregarMes(partes[0], partes[1])
      .catch(function () {
        // GET falhou (ex.: token inválido). A batida NÃO pode se perder:
        // parte do cache local (+ pendências) e deixa o PUT/fila cuidarem
        // do envio — o erro real de escrita sobe para a UI mais adiante.
        var c = lerCache(chave);
        return { dias: aplicarPendencias(chave, c.dias), sha: c.sha };
      })
      .then(function (res) {
        var dia = res.dias[dataISO] || { batidas: [], obs: '', tipo: 'normal' };
        var atualizado = normalizarDia(dia);
        atualizado.batidas.push(hora);
        atualizado.batidas.sort();
        var msg = 'ponto: batida ' + dataISO + ' ' + hora;
        return salvarDia(dataISO, atualizado, msg).catch(function (e) {
          // A batida já está no cache local e na fila de pendências.
          // Anexa o dia ao erro para a UI conseguir mostrar o estado local.
          if (e) e.dia = atualizado;
          throw e;
        });
      });
  }

  // ---------------------------------------------------------------
  // API pública: sincronizarPendentes
  // ---------------------------------------------------------------

  /**
   * Tenta enviar ao GitHub tudo o que ficou pendente por falta de rede.
   * Processa em ordem; para no primeiro erro de rede (tenta de novo depois).
   * @returns {Promise<{enviadas:number, restantes:number}>}
   */
  function sincronizarPendentes() {
    var cfg = getConfig();
    if (modoLocal(cfg)) {
      return Promise.resolve({ enviadas: 0, restantes: 0 });
    }
    if (sincronizando) {
      return Promise.resolve({ enviadas: 0, restantes: lerPendentes().length });
    }
    sincronizando = true;
    var enviadas = 0;

    function proxima() {
      var lista = lerPendentes();
      if (lista.length === 0) {
        return Promise.resolve();
      }
      var item = lista[0];
      var chave = mesDaData(item.dataISO);
      var msg = (item.mensagem || 'ponto: atualiza ' + item.dataISO) + ' (sincronizado)';

      return githubGetMes(cfg, chave)
        .then(function (res) {
          // MESCLA com o dia remoto (união das batidas) em vez de
          // substituir: se o remoto já recebeu batidas mais novas depois
          // que a pendência foi criada, elas são preservadas.
          res.dias[item.dataISO] = mesclarDia(res.dias[item.dataISO], item.dia);
          return githubPutMes(cfg, chave, res.dias, res.sha, msg).then(function (novoSha) {
            gravarCache(chave, res.dias, novoSha);
          });
        })
        .then(function () {
          // Remove o item enviado e segue para o próximo.
          var atual = lerPendentes();
          atual = atual.filter(function (p) {
            return !(p.dataISO === item.dataISO && p.ts === item.ts);
          });
          gravarPendentes(atual);
          enviadas++;
          limparUltimoErro(); // sincronização deu certo
          return proxima();
        })
        .catch(function (e) {
          if (e && e.conflito) {
            // Conflito: simplesmente tenta de novo (o GET seguinte pega o SHA novo).
            return proxima();
          }
          // Erro de rede ou outro: para por aqui; o restante fica na fila.
          throw e;
        });
    }

    return proxima()
      .then(function () {
        sincronizando = false;
        return { enviadas: enviadas, restantes: lerPendentes().length };
      })
      .catch(function (e) {
        sincronizando = false;
        registrarUltimoErro(e && e.message);
        return { enviadas: enviadas, restantes: lerPendentes().length };
      });
  }

  // ---------------------------------------------------------------
  // API pública: testarConexao
  // ---------------------------------------------------------------

  /**
   * Testa a configuração atual contra a API do GitHub.
   * @returns {Promise<{ok:boolean, mensagem:string}>} nunca rejeita.
   */
  function testarConexao() {
    var cfg = getConfig();

    if (cfg.demo) {
      return Promise.resolve({
        ok: true,
        mensagem: 'Modo demonstração ativo: os dados ficam apenas neste dispositivo.'
      });
    }
    if (!cfg.owner || !cfg.repo || !cfg.token) {
      return Promise.resolve({
        ok: false,
        mensagem: 'Configuração incompleta: informe usuário, repositório e token do GitHub.'
      });
    }

    var url =
      API_BASE +
      '/repos/' +
      encodeURIComponent(cfg.owner) +
      '/' +
      encodeURIComponent(cfg.repo);

    return fetch(url, { headers: cabecalhos(cfg) })
      .then(function (resp) {
        if (resp.status === 401) {
          return {
            ok: false,
            status: 401,
            mensagem: 'Falha (HTTP 401): token do GitHub inválido ou expirado. Gere um novo token e atualize as configurações.'
          };
        }
        if (resp.status === 404) {
          return {
            ok: false,
            status: 404,
            mensagem:
              'Falha (HTTP 404): repositório "' + cfg.owner + '/' + cfg.repo +
              '" não encontrado. Confira o nome ou as permissões do token.'
          };
        }
        if (!resp.ok) {
          return { ok: false, status: resp.status, mensagem: 'Falha (HTTP ' + resp.status + ') ao testar a conexão com o GitHub.' };
        }
        return resp.json().then(function (json) {
          if (json.permissions && json.permissions.push === false) {
            return {
              ok: false,
              mensagem: 'Conectado, mas o token não tem permissão de escrita neste repositório.'
            };
          }
          return {
            ok: true,
            mensagem: 'Conexão OK com "' + cfg.owner + '/' + cfg.repo + '". Pronto para registrar o ponto.'
          };
        });
      })
      .catch(function () {
        return {
          ok: false,
          mensagem: 'Sem conexão com a internet. Os registros serão salvos localmente até a rede voltar.'
        };
      });
  }

  // ---------------------------------------------------------------
  // Exposição global (contrato)
  // ---------------------------------------------------------------
  window.PontoStorage = {
    // Configuração
    getConfig: getConfig,
    setConfig: setConfig,
    // Dados
    carregarMes: carregarMes,
    salvarDia: salvarDia,
    baterPonto: baterPonto,
    // Sincronização / diagnóstico
    sincronizarPendentes: sincronizarPendentes,
    testarConexao: testarConexao,
    contarPendentes: contarPendentes,
    ultimoErroSync: ultimoErroSync,
    // Utilitários de data no fuso America/Sao_Paulo (úteis para a UI)
    hojeISO: hojeISO,
    horaAgoraHHMM: horaAgoraHHMM
  };
})();
