const fs = require('fs');
module.exports = ({ app, win, send }) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const js = c => win.webContents.executeJavaScript(c);
  const realClick = async sel => {
    const r = JSON.parse(await js(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`));
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await wait(100);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
    await wait(700);
  };
  (async () => {
    await wait(2000);
    await realClick('#open-settings');
    console.log('1 open settings ->', await js('document.body.classList.contains("sheet-open")'), 'fullscreen:', win.isFullScreen());
    await js("document.querySelector('.switch[data-key=alwaysOnTop]').scrollIntoView({block:'center'})"); await wait(400); await realClick('.switch[data-key="alwaysOnTop"]');
    console.log('2 switch alwaysOnTop ->', JSON.parse(fs.readFileSync('/tmp/mirrorly-test/settings.json')).alwaysOnTop);
    await js("document.querySelector('#s-quality').scrollIntoView({block:'center'})"); await wait(400); await realClick('#s-quality button[data-v="720"]');
    console.log('3 quality ->', JSON.parse(fs.readFileSync('/tmp/mirrorly-test/settings.json')).quality);
    fs.writeFileSync('/tmp/shots/click-settings.png', (await win.webContents.capturePage()).toPNG());
    await realClick('#close-settings');
    console.log('4 close ->', !(await js('document.body.classList.contains("sheet-open")')));
    // during streaming, controls must still be clickable when visible
    send('session-start', { name: 'iPhone' });
    await wait(500);
    await js("document.getElementById('stream-view').dispatchEvent(new MouseEvent('mousemove'))");
    await wait(400);
    await realClick('#c-pin');
    console.log('5 stream pin button ->', JSON.parse(fs.readFileSync('/tmp/mirrorly-test/settings.json')).alwaysOnTop);
    app.exit(0);
  })();
};
