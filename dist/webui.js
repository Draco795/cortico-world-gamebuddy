/**
 * 陪玩搭子的面板：总开关 + 两个库采集开关 + 自动打游戏一键开关 + 读一眼 / 要打法。
 * 纯手写 ESM，Coopanion 直接 import 它作为 webUiClient。
 */

const TEXT = {
  zh: {
    title: '陪玩搭子',
    on: '陪玩中 · 点一下关闭',
    off: '已关闭 · 点一下开启',
    hintOn: '她会自己看局势、偶尔吐槽；你问她就给打法。',
    hintOff: '不读屏、不搭话、不占资源。要用的时候点上面那行。',
    look: '读一眼牌面',
    advise: '要个打法',
    speak: '说一句',
    situation: '（可选）补一句现状：身份、血量、手上有什么',
    ask: '带着这句问',
    busy: '正在读…',
    failed: '调用失败：',
    offRefuse: '陪玩已关闭，先打开开关。',
    collectGenerals: '武将库采集',
    collectSlang: '黑话库采集',
    collectOn: '开',
    collectOff: '关',
    collectHint: '想要新料就打开，专心打就关掉；关掉只是不记新东西，已入库的照样能用。',
  },
  en: {
    title: 'Play-along buddy',
    on: 'Companion on · tap to turn off',
    off: 'Companion off · tap to turn on',
    hintOn: 'She watches the board and speaks up now and then; ask and she gives a line.',
    hintOff: 'No reading, no comments, no cost. Tap the bar above when you want her back.',
    look: 'Read the board',
    advise: 'Ask for a line',
    speak: 'Say something',
    situation: 'Optionally describe the board: identity, HP, cards in hand',
    ask: 'Ask with this',
    busy: 'Reading…',
    failed: 'Failed: ',
    offRefuse: 'Companion is off — turn it on first.',
    collectGenerals: 'General book',
    collectSlang: 'Slang book',
    collectOn: 'on',
    collectOff: 'off',
    collectHint: 'Turn on when you want new entries; off just stops collecting — what is already stored still works.',
  },
};

function el(tag, style) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  return node;
}

const panel = {
  async mount(ctx) {
    const t = TEXT[ctx.language === 'en' ? 'en' : 'zh'];
    const root = ctx.root;
    root.innerHTML = '';

    let armed = true;

    // 总开关：整块可点，状态一眼可见
    const toggle = el(
      'button',
      'width:100%;text-align:left;font:600 13px/1.3 inherit;padding:10px 12px;border-radius:10px;cursor:pointer;'
        + 'border:1px solid rgba(127,127,127,.35);transition:background .15s,color .15s',
    );
    const hint = el('div', 'font:11px/1.5 inherit;color:rgba(127,127,127,.95);margin:6px 2px 10px');
    root.append(toggle, hint);

    // 两个库的采集开关：随时能打开，不想要新料就关掉（已入库的不受影响）
    const collectRow = el('div', 'display:flex;gap:6px;margin:0 0 4px');
    const collectHint = el('div', 'font:11px/1.5 inherit;color:rgba(127,127,127,.95);margin:0 2px 10px');
    collectHint.textContent = t.collectHint;
    let collectGenerals = true;
    let collectSlang = true;

    const switchBtn = (key) => {
      const b = el(
        'button',
        'flex:1;font:12px/1.2 inherit;padding:7px 8px;border-radius:9px;cursor:pointer;transition:background .15s,color .15s;'
          + 'border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.08)',
      );
      b.addEventListener('click', async () => {
        const next = key === 'generals' ? !collectGenerals : !collectSlang;
        try {
          await ctx.invoke('setCollect', [key, next]);
          await refresh();
        } catch (error) {
          render(t.failed + String(error));
        }
      });
      collectRow.append(b);
      return b;
    };
    const generalsBtn = switchBtn('generals');
    const slangBtn = switchBtn('slang');
    root.append(collectRow, collectHint);

    const out = el(
      'pre',
      'white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,Consolas,monospace;'
        + 'background:rgba(127,127,127,.10);border-radius:8px;padding:8px 10px;margin:0 0 8px;max-height:200px;overflow:auto',
    );
    root.append(out);

    const row = el('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px');
    const buttons = [];
    const button = (label, fn) => {
      const b = el(
        'button',
        'font:12px/1.2 inherit;padding:6px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);'
          + 'background:rgba(127,127,127,.08);cursor:pointer',
      );
      b.textContent = label;
      b.addEventListener('click', () => void fn());
      row.append(b);
      buttons.push(b);
      return b;
    };

    const render = (text) => {
      out.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    };

    const paint = () => {
      toggle.textContent = armed ? t.on : t.off;
      toggle.style.background = armed ? 'rgba(44,160,96,.16)' : 'rgba(127,127,127,.10)';
      toggle.style.color = armed ? 'rgb(30,140,80)' : 'rgba(110,110,110,1)';
      hint.textContent = armed ? t.hintOn : t.hintOff;
      for (const b of buttons) {
        b.disabled = !armed;
        b.style.opacity = armed ? '1' : '.45';
        b.style.cursor = armed ? 'pointer' : 'default';
      }
      const paintSwitch = (btn, label, on) => {
        btn.textContent = `${label} · ${on ? t.collectOn : t.collectOff}`;
        btn.style.color = on ? 'rgb(30,140,80)' : 'rgba(110,110,110,1)';
        btn.style.background = on ? 'rgba(44,160,96,.16)' : 'rgba(127,127,127,.08)';
        btn.style.opacity = armed ? '1' : '.55';
      };
      paintSwitch(generalsBtn, t.collectGenerals, collectGenerals);
      paintSwitch(slangBtn, t.collectSlang, collectSlang);
    };

    const refresh = async (keepText = false) => {
      try {
        const st = await ctx.invoke('state');
        armed = Boolean(st && st.armed);
        collectGenerals = st && st.collectGenerals !== false;
        collectSlang = st && st.collectSlang !== false;
        paint();
        if (!keepText) render(await ctx.invoke('status'));
      } catch (error) {
        render(t.failed + (error instanceof Error ? error.message : String(error)));
      }
    };

    toggle.addEventListener('click', async () => {
      try {
        await ctx.invoke(armed ? 'off' : 'on');
        await refresh();
      } catch (error) {
        render(t.failed + String(error));
      }
    });

    const guard = (fn) => async () => {
      if (!armed) {
        render(t.offRefuse);
        return;
      }
      out.textContent = t.busy;
      try {
        render(await fn());
      } catch (error) {
        render(t.failed + String(error));
      }
    };

    button(t.look, guard(() => ctx.invoke('look')));
    button(t.advise, guard(() => ctx.invoke('advise')));
    button(t.speak, guard(() => ctx.invoke('comment')));
    root.append(row);

    const box = el('div', 'display:flex;gap:6px');
    const input = el(
      'input',
      'flex:1;min-width:0;font:12px/1.4 inherit;padding:6px 8px;border-radius:8px;'
        + 'border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit',
    );
    input.placeholder = t.situation;
    const ask = el(
      'button',
      'font:12px/1.2 inherit;padding:6px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);'
        + 'background:rgba(127,127,127,.08);cursor:pointer',
    );
    ask.textContent = t.ask;
    ask.addEventListener('click', guard(() => ctx.invoke('advise', [input.value])));
    box.append(input, ask);
    root.append(box);

    paint();
    await refresh();
    if (typeof ctx.interval === 'function') ctx.interval(() => void refresh(), 15_000);
  },
};

export default { panels: { main: panel } };
