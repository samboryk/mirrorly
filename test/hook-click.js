const fs = require('fs');
module.exports = ({ app, win }) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const js = c => win.webContents.executeJavaScript(c);
  win.webContents.on('console-message', e => console.log('renderer:', e.message));
  const click = async (x, y) => { for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); };
  (async () => {
    await wait(2000);
    const r = JSON.parse(await js("JSON.stringify(document.getElementById('open-settings').getBoundingClientRect())"));
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    console.log('btn at', x, y, 'top element:', await js(`(()=>{const e=document.elementFromPoint(${x},${y});return e.tagName+'#'+e.id+'.'+e.className})()`));
    await js("['pointerdown','mousedown','mouseup','click'].forEach(t=>document.addEventListener(t,e=>console.log('EV',t,e.target.tagName,e.button),true))");
    console.log('handler:', await js("typeof document.getElementById('open-settings').onclick"));
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(200);
    await click(x, y); await wait(1000);
    console.log('after real click:', await js('document.body.className'));
    await js("document.getElementById('open-settings').click()"); await wait(1000);
    console.log('body after click:', await js('document.body.className'));
    fs.writeFileSync('/tmp/shots/click.png', (await win.webContents.capturePage()).toPNG());
    app.exit(0);
  })();
};
