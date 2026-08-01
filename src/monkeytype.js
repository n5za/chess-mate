// MonkeyType speed typer: reads the active word and types it perfectly and fast.
// Runs only on monkeytype.com. Keeps typing on every new test automatically.
(function () {
  if (location.hostname !== 'monkeytype.com' && !window.__MONKEYTYPE_TEST__) return;

  const CHAR_MS = 25;       // ms per character (very fast typing)
  const WORD_GAP_MS = 70;   // pause between words
  let lastWord = null;
  let typing = false;
  let stopFlag = false;

  function keyDown(key, code) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code,
      keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : key === ' ' ? 32 : 0,
      bubbles: true,
      cancelable: true
    }));
  }

  function typeChar(ch) {
    if (stopFlag) return;
    if (ch === ' ') {
      keyDown(' ', 'Space');
    } else {
      keyDown(ch, 'Key' + ch.toUpperCase());
    }
  }

  function activeWord() {
    return document.querySelector('.word.active');
  }

  function wordLetters(word) {
    const els = word.querySelectorAll('.letter');
    if (els.length) {
      let s = '';
      els.forEach((el) => { s += el.textContent || ''; });
      return s;
    }
    return word.textContent || '';
  }

  function isLastWord(word) {
    const words = document.querySelectorAll('.word');
    return words.length > 0 && word === words[words.length - 1];
  }

  function typeWord(word) {
    const letters = wordLetters(word);
    if (!letters) return;
    typing = true;
    let i = 0;
    const step = () => {
      if (stopFlag || !word.isConnected) { typing = false; return; }
      if (i < letters.length) {
        typeChar(letters[i++]);
        setTimeout(step, CHAR_MS);
      } else {
        if (isLastWord(word)) {
          typing = false;
        } else {
          typeChar(' ');
          setTimeout(() => { typing = false; }, WORD_GAP_MS);
        }
      }
    };
    step();
  }

  function tick() {
    if (typing) return;
    const word = activeWord();
    if (!word) { lastWord = null; return; }
    if (word === lastWord) return;
    lastWord = word;
    typeWord(word);
  }

  // Pause while the tab is hidden or the page is blurred (looks natural).
  document.addEventListener('visibilitychange', () => {
    stopFlag = document.hidden;
  });
  window.addEventListener('blur', () => {
    stopFlag = true;
  });
  window.addEventListener('focus', () => {
    stopFlag = false;
  });

  setInterval(tick, 150);
})();
