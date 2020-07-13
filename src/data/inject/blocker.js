/* global script */
'use strict';

if (document.contentType === 'text/html') {
  // Firefox issue; document.activeElement is always <body/>
  if (/Firefox/.test(navigator.userAgent)) {
    let activeElement = document.documentElement;
    document.addEventListener('click', e => activeElement = e.target, true);
    Object.defineProperty(document, 'activeElement', {
      get() {
        return activeElement;
      }
    });
  }
  // record fake window's executed commands
  const records = {};
  // should I display popups
  let silent = false;

  const _prefs = { // Firefox issue
    'enabled': true,
    'shadow': false,
    'domain': false,
    'protocols': ['magnet:'],
    'popup-hosts': ['google.com', 'bing.com', 't.co', 'twitter.com', 'disqus.com'],
    'block-page-redirection': false
  };
  const prefs = new Proxy(_prefs, {
    set(obj, key, value) {
      obj[key] = value;
      // allow the unprotected code to get relevant preferences
      if (key === 'enabled' || key === 'shadow') {
        script.dataset[key] = value;
      }
      return true;
    }
  });
  // make sure we have access to our preferences from the same origin iframes
  window.prefs = prefs;
  window.silent = silent;

  // try to get the preferences from the top element; otherwise get them from chrome.storage
  {
    let loaded = false;
    if (window.parent !== window) {
      // console.log(window.parent.prefs, self.parent.prefs, this.parent.prefs, parent.prefs);
      try {
        if (window.parent.prefs !== undefined) { // Firefox issue
          Object.assign(prefs, window.parent.prefs);
          silent = window.parent.silent;
          loaded = true;
        }
      }
      catch (e) {}
    }
    if (loaded === false) {
      chrome.storage.local.get(_prefs, ps => {
        Object.assign(prefs, ps);
        if (prefs.enabled) {
          chrome.runtime.sendMessage({
            cmd: 'exception',
            href: location.href,
            hostname: location.hostname
          }, response => {
            silent = response.silent;
            if (response.enabled === false) {
              prefs.enabled = false;
            }
          });
        }
      });
    }
  }

  // listen for enabled preference changes
  chrome.storage.onChanged.addListener(ps => {
    Object.keys(ps).filter(key => key in _prefs).forEach(key => prefs[key] = ps[key].newValue);
  });

  const blocker = {};

  blocker.hasBase = a => {
    // only check the closest base
    const base = [a, ...document.querySelectorAll('base')]
      .map(e => e && e.target ? e.target.toLowerCase() : '')
      .filter(b => b).shift();
    // the linked page opens in the named frame
    return base ? base !== '_self' && typeof window[base] !== 'object' : false;
  };

  blocker.policy = request => {
    const target = document.activeElement;
    const {type} = request;
    let href = request.href;
    let hostname = '';
    let block = true;
    let sameContext = false;

    if (type === 'element.click') {
      const a = 'closest' in target ? (target.closest('[target]') || target.closest('a')) : null;
      href = href || (a ? a.href || a.action : '');
      // we are blocking either if a is found or href is provided; see method 12/4
      block = Boolean(a) || href;
    }
    // always run window open on the same context
    if (type === 'window.open') {
      sameContext = true;
    }
    else {
      block = block && blocker.hasBase({
        target: request.target
      });
    }
    // block if
    if (request.metaKey && request.isTrusted === false) { // see method 12/5
      block = true;
    }
    if ('button' in request && request.button !== 0 && request.isTrusted === false) { // see method 12/2
      block = true;
    }
    // do not block if
    if (request.defaultPrevented || (request.metaKey && request.isTrusted)) {
      block = false;
    }
    // fixing
    if (block) {
      // fix relative href
      if (href && href.indexOf(':') === -1) {
        const a = document.createElement('a');
        a.setAttribute('href', href);
        href = a.href;
      }
      // create a unique id when "href" is not usable
      if (!href || href.startsWith('about:')) {
        target.dataset.ppbid = target.dataset.ppbid || Math.random();
      }
      if (href) {
        try {
          const loc = new URL(href);
          hostname = loc.hostname;
          // allow popups from the same hostname
          if (prefs.domain) {
            try { // if they are not in the same origin
              const h = window.top.location.hostname;
              if (h && hostname && (h.endsWith('.' + hostname) || hostname.endsWith('.' + h) || hostname === h)) {
                block = false;
              }
            }
            catch (e) {}
          }
          // protocol matching
          if (loc.protocol && prefs.protocols.indexOf(loc.protocol) !== -1) {
            block = false;
          }
          // white-list matching
          if (hostname) {
            for (const h of prefs['popup-hosts']) {
              if (h.endsWith('.' + hostname) || hostname.endsWith('.' + h) || hostname === h) {
                block = false;
              }
            }
          }
        }
        catch (e) {}
      }
    }

    const id = target.dataset.ppbid || Math.random();
    if (sameContext) {
      records[id] = [{
        name: 'self',
        method: 'open',
        args: request.args
      }];
    }

    return {
      id,
      href,
      hostname,
      sameContext,
      block
    };
  };

  // page redirection; prevent the page redirection when popup opening is unsuccessful for 2 seconds
  const redirect = {
    timeout: null,
    beforeunload: e => {
      e.returnValue = 'false';
    },
    block: () => {
      if (prefs['block-page-redirection'] && window.top === window) {
        window.addEventListener('beforeunload', redirect.beforeunload);
        window.clearTimeout(redirect.timeout);
        redirect.timeout = window.setTimeout(() => {
          window.removeEventListener('beforeunload', redirect.beforeunload);
        }, 2000);
      }
    },
    release: () => {
      window.removeEventListener('beforeunload', redirect.beforeunload);
      window.clearTimeout(redirect.timeout);
    }
  };
  // channel
  script.addEventListener('policy', e => {
    // make sure the request is from our script; see example 1
    if (e.target === script) {
      if (prefs.enabled) {
        const request = e.detail;
        const {block, id, href, hostname} = blocker.policy(request);
        script.setAttribute('eid', id);
        script.setAttribute('block', block);

        // console.log(request, block);
        if (block) {
          redirect.block();
          chrome.runtime.sendMessage({
            cmd: 'popup-request',
            type: request.type,
            href,
            hostname,
            id,
            silent
          });
        }
      }
      // when a new iframe is loaded and the blocker is disabled but the preferences are not yet ported
      else {
        script.setAttribute('block', false);
      }
    }
  });

  // record
  script.addEventListener('record', e => {
    const {id, name, method, args} = e.detail;
    records[id].push({name, method, args});
  });

  // perform popup accepted command on the same context
  chrome.runtime.onMessage.addListener((request, sender, response) => {
    // apply popup-accept on the context where it is originally requested
    if (request.cmd === 'popup-accepted') {
      prefs.enabled = false;
      const script = document.createElement('script');
      if (records[request.id]) {
        script.dataset.commands = JSON.stringify(records[request.id]);
        delete records[request.id];
        script.textContent = `{
          const [{method, args}, ...commands] = JSON.parse(document.currentScript.dataset.commands);
          const loaded = [window[method].apply(window, args)];
          commands.forEach(({name, method, args}) => {
            const o = loaded.map(o => o[name]).filter(o => o).shift();
            if (loaded.indexOf(o) === -1) {
              loaded.push(o);
            }
            o[method].apply(o, args);
          });
        }`;
      }
      else {
        script.textContent = `{
          const a = document.createElement('a');
          a.target = '_blank';
          a.href = '${request.url}';
          a.click();
        }`;
      }
      document.body.appendChild(script);
      script.remove();
      prefs.enabled = true;
    }
    else if (request.cmd === 'use-shadow') {
      prefs.shadow = true;
    }
    else if (request.cmd === 'release-beforeunload') {
      redirect.release();
      response(true); // Edge thing!
    }
  });
}
