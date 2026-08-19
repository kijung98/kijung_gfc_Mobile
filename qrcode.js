// 세일즈맵 — QR 코드 생성 엔진 (자체 포함, 오프라인 동작)
// byte 모드 + UTF-8 + 자동 버전 선택(1~40) + 마스크 최적화.
// 외부 라이브러리/네트워크 없이 동작하도록 QR 표준(ISO/IEC 18004) 알고리즘을 직접 구현했습니다.
// 알고리즘 구조는 Project Nayuki의 QR Code generator(공개 도메인)를 참고했습니다.
(function () {
  'use strict';

  // 오류정정 수준별 블록당 EC 코드워드 수 [ecl][version(1~40)]. index 0은 자리표시(미사용).
  // ecl 순서: 0=L, 1=M, 2=Q, 3=H
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  // 포맷 정보용 EC 수준 비트: L=1, M=0, Q=3, H=2
  var ECL_FORMAT_BITS = [1, 0, 3, 2];

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // ---- 갈루아 필드 GF(256) 연산 & 리드-솔로몬 ----
  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsComputeDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }
  function rsComputeRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMultiply(coef, factor); });
    });
    return result;
  }

  // ---- 용량 계산 ----
  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8)
      - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  }

  // ---- 문자열 → UTF-8 바이트 ----
  function toUtf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(str));
    var utf8 = unescape(encodeURIComponent(str));
    var arr = [];
    for (var i = 0; i < utf8.length; i++) arr.push(utf8.charCodeAt(i));
    return arr;
  }

  function appendBits(val, len, bb) {
    for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }

  // ---- 데이터 + EC 인터리브 ----
  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [];
    var rsDiv = rsComputeDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = rsComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        // 짧은 블록의 패딩 위치는 건너뛴다.
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  // ---- 모듈 배치 & 마스킹 ----
  function drawMatrix(codewords, ver, ecl) {
    var size = ver * 4 + 17;
    var modules = [], isFunction = [];
    for (var i = 0; i < size; i++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }
    function setFn(x, y, dark) { modules[y][x] = dark; isFunction[y][x] = true; }

    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = cx + dx, yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
    function drawAlign(cx, cy) {
      for (var dy = -2; dy <= 2; dy++)
        for (var dx = -2; dx <= 2; dx++)
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    function alignPositions() {
      if (ver === 1) return [];
      var numAlign = Math.floor(ver / 7) + 2;
      var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
      var result = [6];
      for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
      return result;
    }
    function drawFormat(mask) {
      var data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      for (var i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
      setFn(8, 7, getBit(bits, 6));
      setFn(8, 8, getBit(bits, 7));
      setFn(7, 8, getBit(bits, 8));
      for (var i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
      for (var i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
      for (var i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
      setFn(8, size - 8, true);
    }
    function drawVersion() {
      if (ver < 7) return;
      var rem = ver;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bits = (ver << 12) | rem;
      for (var i = 0; i < 18; i++) {
        var color = getBit(bits, i);
        var a = size - 11 + i % 3, b = Math.floor(i / 3);
        setFn(a, b, color); setFn(b, a, color);
      }
    }
    function drawFunctionPatterns() {
      for (var i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
      drawFinder(3, 3); drawFinder(size - 4, 3); drawFinder(3, size - 4);
      var pos = alignPositions(), n = pos.length;
      for (var i = 0; i < n; i++)
        for (var j = 0; j < n; j++)
          if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)))
            drawAlign(pos[i], pos[j]);
      drawFormat(0); drawVersion();
    }
    function drawCodewords(data) {
      var idx = 0;
      for (var right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (var vert = 0; vert < size; vert++) {
          for (var j = 0; j < 2; j++) {
            var x = right - j;
            var upward = ((right + 1) & 2) === 0;
            var y = upward ? size - 1 - vert : vert;
            if (!isFunction[y][x] && idx < data.length * 8) {
              modules[y][x] = getBit(data[idx >>> 3], 7 - (idx & 7));
              idx++;
            }
          }
        }
      }
    }
    function applyMask(mask) {
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var invert = false;
          switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
            case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
            case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
          }
          if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x];
        }
      }
    }
    // 마스크 페널티(스캔 신뢰도용) — 낮을수록 좋음
    function finderPenaltyCount(rh) {
      var n = rh[1];
      var core = n > 0 && rh[2] === n && rh[3] === n * 3 && rh[4] === n && rh[5] === n;
      return (core && rh[0] >= n * 4 && rh[6] >= n ? 1 : 0) + (core && rh[6] >= n * 4 && rh[0] >= n ? 1 : 0);
    }
    function finderPenaltyAddHistory(run, rh) {
      if (rh[0] === 0) run += size;
      rh.pop(); rh.unshift(run);
    }
    function finderPenaltyTerminate(color, run, rh) {
      if (color) { finderPenaltyAddHistory(run, rh); run = 0; }
      run += size;
      finderPenaltyAddHistory(run, rh);
      return finderPenaltyCount(rh);
    }
    function penaltyScore() {
      var result = 0, x, y;
      for (y = 0; y < size; y++) {
        var runColor = false, runX = 0, rh = [0, 0, 0, 0, 0, 0, 0];
        for (x = 0; x < size; x++) {
          if (modules[y][x] === runColor) { runX++; if (runX === 5) result += 3; else if (runX > 5) result++; }
          else { finderPenaltyAddHistory(runX, rh); if (!runColor) result += finderPenaltyCount(rh) * 40; runColor = modules[y][x]; runX = 1; }
        }
        result += finderPenaltyTerminate(runColor, runX, rh) * 40;
      }
      for (x = 0; x < size; x++) {
        var runColor2 = false, runY = 0, rh2 = [0, 0, 0, 0, 0, 0, 0];
        for (y = 0; y < size; y++) {
          if (modules[y][x] === runColor2) { runY++; if (runY === 5) result += 3; else if (runY > 5) result++; }
          else { finderPenaltyAddHistory(runY, rh2); if (!runColor2) result += finderPenaltyCount(rh2) * 40; runColor2 = modules[y][x]; runY = 1; }
        }
        result += finderPenaltyTerminate(runColor2, runY, rh2) * 40;
      }
      for (y = 0; y < size - 1; y++)
        for (x = 0; x < size - 1; x++) {
          var c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
        }
      var dark = 0;
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (modules[y][x]) dark++;
      var total = size * size;
      var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      result += k * 10;
      return result;
    }

    drawFunctionPatterns();
    drawCodewords(codewords);
    var mask = 0, minPenalty = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      var p = penaltyScore();
      if (p < minPenalty) { mask = m; minPenalty = p; }
      applyMask(m); // 원복 (XOR)
    }
    applyMask(mask); drawFormat(mask);
    return modules;
  }

  // ---- 공개 API ----
  // encode(text, eclName) → 2차원 boolean 매트릭스 (true = 검은 모듈)
  function encode(text, eclName) {
    var ecl = { L: 0, M: 1, Q: 2, H: 3 }[(eclName || 'M').toUpperCase()];
    if (ecl == null) ecl = 1;
    var bytes = toUtf8(text);
    var ver;
    for (ver = 1; ; ver++) {
      if (ver > 40) throw new Error('QR: 데이터가 너무 깁니다.');
      var capacity = getNumDataCodewords(ver, ecl) * 8;
      var ccBits = (ver <= 9) ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= capacity) break;
    }
    var capBits = getNumDataCodewords(ver, ecl) * 8;
    var bb = [];
    appendBits(0x4, 4, bb);                       // byte 모드 지시자
    appendBits(bytes.length, (ver <= 9) ? 8 : 16, bb); // 문자 수 지시자
    for (var i = 0; i < bytes.length; i++) appendBits(bytes[i], 8, bb);
    appendBits(0, Math.min(4, capBits - bb.length), bb);      // 종료자
    appendBits(0, (8 - bb.length % 8) % 8, bb);               // 바이트 정렬
    for (var pad = 0xEC; bb.length < capBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8, bb); // 패딩
    var dataCodewords = new Array(bb.length / 8).fill(0);
    for (var i = 0; i < bb.length; i++) dataCodewords[i >>> 3] |= bb[i] << (7 - (i & 7));
    var all = addEccAndInterleave(dataCodewords, ver, ecl);
    return drawMatrix(all, ver, ecl);
  }

  // 매트릭스를 canvas에 렌더링. opts: {maxSize, border, dark, light}
  function drawCanvas(matrix, canvas, opts) {
    opts = opts || {};
    var border = (opts.border != null) ? opts.border : 4;
    var maxPx = opts.maxSize || 320;
    var n = matrix.length;
    var scale = Math.max(1, Math.floor(maxPx / (n + border * 2)));
    var dim = (n + border * 2) * scale;
    canvas.width = dim; canvas.height = dim;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || '#000000';
    for (var y = 0; y < n; y++)
      for (var x = 0; x < n; x++)
        if (matrix[y][x]) ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
    return { scale: scale, dim: dim };
  }

  window.SalesMapQR = { encode: encode, drawCanvas: drawCanvas };
})();
