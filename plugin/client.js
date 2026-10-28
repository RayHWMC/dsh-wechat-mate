(function () {
  window.__ModuleLoader__.load({
    id: '@rayhwmc/dsh-wechat-mate',
    factory: require => {
      const React = require('react');
      const h = React.createElement;
      const API = '/.dsh-wechat-mate';
      const fields = [
        ['repo', 'Bridge directory'], ['python', 'Python interpreter'],
        ['display', 'X11 display'], ['cwd', 'Session workspace'],
        ['sessionId', 'Session prefix'], ['preset', 'Agent preset'],
        ['provider', 'Model provider'], ['model', 'Model'],
      ];
      const phases = {
        starting: 'Starting watcher…', running: 'Receiving messages', stopped: 'Stopped',
        error: 'Watcher failed', exited: 'Watcher exited', unsupported: 'Linux host required',
      };
      async function request(path, options) {
        const response = await fetch(API + path, options);
        const body = await response.json();
        if (!response.ok) throw Error(body.error || `Request failed (${response.status})`);
        return body;
      }
      function Panel() {
        const [state, setState] = React.useState(null);
        const [draft, setDraft] = React.useState(null);
        const [error, setError] = React.useState('');
        const [loadError, setLoadError] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const [saving, setSaving] = React.useState(false);
        const [dirty, setDirty] = React.useState(false);
        React.useEffect(() => {
          let active = true;
          let timer;
          const controller = new AbortController();
          async function refresh() {
            try {
              const value = await request('/status', { signal: controller.signal });
              if (active) {
                setState(value);
                setDraft(previous => previous ?? value.settings);
                setLoadError('');
              }
            } catch (e) { if (active) setLoadError(e.message); }
            if (active) timer = setTimeout(refresh, 3000);
          }
          void refresh();
          return () => { active = false; controller.abort(); clearTimeout(timer); };
        }, []);
        function change(key, value) {
          setDraft(previous => ({ ...previous, [key]: value }));
          setDirty(true); setNotice('');
        }
        async function save(event) {
          event.preventDefault(); setSaving(true); setError(''); setNotice('');
          try {
            const value = await request('/settings', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
            });
            setState(value); setDraft(value.settings); setDirty(false);
            setNotice(value.health.phase === 'error' || value.health.phase === 'unsupported'
              ? 'Settings saved. Check the channel status below.' : 'Settings saved. Channel configuration applied.');
          } catch (e) { setError(e.message); }
          finally { setSaving(false); }
        }
        const health = state?.health;
        return h('section', { className: 'wechat-mate', 'aria-label': 'WeChat Mate settings' },
          h('style', null, `
            .wechat-mate{max-width:760px;padding:24px;color:inherit;font:inherit}
            .wechat-mate h2{font-size:22px;margin:0 0 8px}.wechat-mate p{line-height:1.6}
            .wechat-mate .wm-muted{opacity:.72}.wechat-mate .wm-status{padding:16px;border:1px solid #8886;border-radius:10px;margin:20px 0}
            .wechat-mate .wm-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
            .wechat-mate label{display:flex;flex-direction:column;gap:6px;font-size:13px}
            .wechat-mate input[type=text],.wechat-mate textarea{box-sizing:border-box;width:100%;border:1px solid #8888;border-radius:6px;background:transparent;color:inherit;padding:9px;font:inherit}
            .wechat-mate .wm-check{display:flex;flex-direction:row;align-items:center;gap:9px;margin:16px 0}
            .wechat-mate button{border:1px solid #8888;background:transparent;color:inherit;border-radius:7px;padding:9px 18px;font:inherit;cursor:pointer}
            .wechat-mate button[type=submit]{background:#24754b;color:white;border-color:#24754b}
            .wechat-mate button:disabled{opacity:.55;cursor:default}.wechat-mate input:focus-visible,.wechat-mate button:focus-visible{outline:2px solid #479eff;outline-offset:2px}
            .wechat-mate .wm-error{color:#d34a46;overflow-wrap:anywhere}.wechat-mate code{overflow-wrap:anywhere}
            @media(max-width:600px){.wechat-mate{padding:16px}.wechat-mate .wm-grid{grid-template-columns:1fr}}
          `),
          h('h2', null, 'WeChat Mate'),
          h('p', { className: 'wm-muted' }, 'Connect DSH to your logged-in official WeChat Linux client through a local X11 bridge.'),
          (error || loadError) && h('p', { role: 'alert', className: 'wm-error' }, error || loadError),
          notice && h('p', { role: 'status' }, notice),
          h('div', { className: 'wm-status', 'aria-live': 'polite' },
            h('strong', null, health ? phases[health.phase] || health.phase : 'Loading channel status…'),
            health && h('p', { className: 'wm-muted' }, `Accepted: ${health.received ?? 0} · Sent: ${health.sent ?? 0} · Queued: ${health.queued ?? 0}`),
            (health?.lastError || state?.lastError) && h('p', { className: 'wm-error' }, health?.lastError || state.lastError)),
          draft && h('form', { onSubmit: save },
            h('fieldset', { disabled: saving, style: { border: 0, padding: 0, margin: 0 } },
              h('label', { className: 'wm-check' },
                h('input', { type: 'checkbox', checked: draft.enabled, onChange: e => change('enabled', e.target.checked) }), 'Enable channel'),
              h('div', { className: 'wm-grid' }, ...fields.map(([key, label]) => h('label', { key }, label,
                h('input', { type: 'text', required: true, value: draft[key], onChange: e => change(key, e.target.value), spellCheck: false })))),
              h('label', { style: { marginTop: 16 } }, 'Your WeChat nicknames (one per line)',
                h('textarea', { rows: 3, value: draft.me.join('\n'), onChange: e => change('me', e.target.value.split('\n')) })),
              h('p', { className: 'wm-muted' }, 'Direct messages wake the agent. Group messages wake it only when they mention a nickname above.'),
              h('label', { className: 'wm-check' },
                h('input', { type: 'checkbox', checked: draft.sendReplies, onChange: e => change('sendReplies', e.target.checked) }), 'Send assistant replies to WeChat'),
              h('button', { type: 'submit', disabled: !dirty || saving }, saving ? 'Saving…' : 'Save settings'),
              dirty && h('span', { style: { marginLeft: 12 }, className: 'wm-muted' }, 'Unsaved changes'))),
          h('p', { className: 'wm-muted' }, 'The bridge must run on the same Linux host as DSH. Install the bridge and OCR dependencies first; confirm WeChat login on your phone.'),
          state?.stateFile && h('details', null, h('summary', null, 'Settings storage'), h('p', null, h('code', null, state.stateFile))),
          h('p', null, h('a', { href: 'https://github.com/RayHWMC/dsh-wechat-mate#readme', target: '_blank', rel: 'noreferrer' }, 'Installation and troubleshooting')),
        );
      }
      function apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'wechat-mate', order: 45,
          label: () => 'WeChat Mate', inject: () => ({}),
        }, Panel)));
      }
      return { name: '@rayhwmc/dsh-wechat-mate', inject: ['slots'], apply };
    },
  });
})();
