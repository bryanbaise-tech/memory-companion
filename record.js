// Names come from the link (?for=Mom&name=Sarah) or what you type; they fill the script.
  const q = new URLSearchParams(location.search);
  const reader = document.getElementById('reader');
  const loved = document.getElementById('loved');
  reader.value = q.get('name') || '';
  loved.value = q.get('for') || '';
  function fill() {
    document.querySelectorAll('.reader').forEach((el) => { el.textContent = reader.value.trim() || '[your name]'; });
    document.querySelectorAll('.loved').forEach((el) => { el.textContent = loved.value.trim() || (el.tagName === 'B' ? 'your loved one' : '[their name]'); });
  }
  reader.addEventListener('input', fill);
  loved.addEventListener('input', fill);
  fill();
