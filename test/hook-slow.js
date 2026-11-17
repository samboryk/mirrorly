module.exports = ({ app, win, receiver }) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const js = c => win.webContents.executeJavaScript(c);
  (async () => {
    await wait(1500);
    await js("document.querySelector('.switch[data-key=askPermission]').click()");
    await js("const o=VideoDecoder.isConfigSupported.bind(VideoDecoder); VideoDecoder.isConfigSupported=async c=>{await new Promise(r=>setTimeout(r,1500)); return o(c)}; true");
    await wait(300);
    const t0 = Date.now();
    const p = require('./fake-sender').run({ port: receiver.port, seconds: 5, log: () => {} });
    let shown = -1;
    for (let i = 0; i < 60; i++) { await wait(100); if (await js("document.body.classList.contains('has-video')")) { shown = Date.now() - t0; break; } }
    console.log('RESULT picture after ms:', shown);
    const r = await p; await r.teardown(); app.exit(0);
  })().catch(e => { console.log('ERR', e); app.exit(1); });
};
