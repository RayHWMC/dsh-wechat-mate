# Implementation references

Reviewed on 2026-10-28. These are implementation references, not dependencies.

* [xcisxc29/dsh-wechat client](https://github.com/xcisxc29/dsh-wechat/blob/main/packages/bundle/client.js):
  classic-script IIFE, `window.__ModuleLoader__.load`, injected `slots`, and a
  scoped `settings.section` registration. We use the same DSH extension points
  for this project's local X11 bridge, with its own package and section identities.
* [xcisxc29/dsh-wechat package](https://github.com/xcisxc29/dsh-wechat/blob/main/package.json):
  repository-root Git installs must expose the host, client, and bundle patch.
* [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the locally
  installed 0.2.0-rc.2 type declarations and implementations for `dsh-agent`,
  `dsh-llm`, `dsh-host-webserver`, `dsh-client-modules`, and `dsh-client-ui-slots`
  were checked against the host and client contracts used here.
* [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter): the installed
  package demonstrates a dual host/client bundle with a settings surface. This
  project keeps its much smaller settings API on DSH's existing web server.

The bridge remains a local Linux/X11 integration. A settings-panel preview with a
React harness verifies rendering and persistence, but does not prove a desktop
profile has activated the plugin or that an actual WeChat client can send messages.
