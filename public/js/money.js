(function () {
  function formatPrice(pence) {
    if (pence == null || pence === '' || Number.isNaN(Number(pence))) return '—';
    const n = Math.round(Number(pence));
    if (Math.abs(n) < 100) return n + 'p';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const pounds = Math.floor(abs / 100).toLocaleString('en-GB');
    const rest = abs % 100;
    if (rest === 0) return sign + '£' + pounds;
    return sign + '£' + pounds + '.' + String(rest).padStart(2, '0');
  }

  function parsePrice(raw, unit) {
    if (raw == null) return null;
    let s = String(raw).trim().toLowerCase().replace(/£/g, '').replace(/\s/g, '');
    if (!s) return null;
    let asPence = unit === 'p';
    if (s.endsWith('p')) {
      asPence = true;
      s = s.slice(0, -1);
    }
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    const pence = asPence ? Math.round(n) : Math.round(n * 100);
    if (pence > 10000000000) return null;
    return pence;
  }

  window.TPIR = { formatPrice, parsePrice };
})();
