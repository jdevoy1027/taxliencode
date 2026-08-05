/* Client-side contouring for scattered point data.

   Same method as the offline build: linear interpolation over a Delaunay
   triangulation, so values are only produced inside the convex hull of the input
   points — no extrapolation into empty ground. Triangles are rasterised straight
   into the grid (barycentric), then marching squares walks the levels and the
   resulting segments are chained into polylines so line-placed labels read well.

   makeContours(points, {interval, grid, index}) -> GeoJSON FeatureCollection
     points : [{x, y, z}]
     feature properties: { e: level, ix: 1 when level is an index contour }
*/
(function (global) {
  'use strict';

  // ---------- Delaunay (Bowyer-Watson) ----------
  function circumcircle(a, b, c) {
    var ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-18) return null;
    var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    var dx = ax - ux, dy = ay - uy;
    return { x: ux, y: uy, r2: dx * dx + dy * dy };
  }

  function delaunay(pts) {
    if (pts.length < 3) return [];
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    pts.forEach(function (p) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    });
    var dx = maxx - minx || 1, dy = maxy - miny || 1, dm = Math.max(dx, dy) * 20;
    var mx = (minx + maxx) / 2, my = (miny + maxy) / 2;
    var st = [
      { x: mx - dm, y: my - dm, z: 0, _s: 1 },
      { x: mx + dm, y: my - dm, z: 0, _s: 1 },
      { x: mx, y: my + dm, z: 0, _s: 1 }
    ];
    var verts = pts.concat(st);
    var n = pts.length;
    var tris = [{ a: n, b: n + 1, c: n + 2, cc: circumcircle(st[0], st[1], st[2]) }];

    for (var i = 0; i < n; i++) {
      var p = verts[i], bad = [], edges = [];
      for (var t = tris.length - 1; t >= 0; t--) {
        var tr = tris[t], cc = tr.cc;
        if (!cc) { tris.splice(t, 1); continue; }
        var ddx = p.x - cc.x, ddy = p.y - cc.y;
        if (ddx * ddx + ddy * ddy <= cc.r2) {
          edges.push([tr.a, tr.b], [tr.b, tr.c], [tr.c, tr.a]);
          tris.splice(t, 1);
        }
      }
      // keep only edges that appear once (the hole boundary)
      for (var e = 0; e < edges.length; e++) {
        var shared = false;
        for (var f = 0; f < edges.length; f++) {
          if (e === f) continue;
          if ((edges[e][0] === edges[f][1] && edges[e][1] === edges[f][0]) ||
              (edges[e][0] === edges[f][0] && edges[e][1] === edges[f][1])) { shared = true; break; }
        }
        if (!shared) {
          var A = verts[edges[e][0]], B = verts[edges[e][1]];
          tris.push({ a: edges[e][0], b: edges[e][1], c: i, cc: circumcircle(A, B, p) });
        }
      }
    }
    return tris.filter(function (tr) {
      return tr.a < n && tr.b < n && tr.c < n;
    });
  }

  // ---------- point in polygon (ray casting) ----------
  function inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ---------- rasterise triangles into a grid ----------
  function rasterise(pts, tris, nx, ny, bbox) {
    var Z = new Float64Array(nx * ny);
    var M = new Uint8Array(nx * ny);
    var x0 = bbox[0], y0 = bbox[1], x1 = bbox[2], y1 = bbox[3];
    var sx = (x1 - x0) / (nx - 1), sy = (y1 - y0) / (ny - 1);

    tris.forEach(function (tr) {
      var A = pts[tr.a], B = pts[tr.b], C = pts[tr.c];
      var tminx = Math.min(A.x, B.x, C.x), tmaxx = Math.max(A.x, B.x, C.x);
      var tminy = Math.min(A.y, B.y, C.y), tmaxy = Math.max(A.y, B.y, C.y);
      var i0 = Math.max(0, Math.floor((tminx - x0) / sx));
      var i1 = Math.min(nx - 1, Math.ceil((tmaxx - x0) / sx));
      var j0 = Math.max(0, Math.floor((tminy - y0) / sy));
      var j1 = Math.min(ny - 1, Math.ceil((tmaxy - y0) / sy));
      var d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
      if (Math.abs(d) < 1e-20) return;
      for (var j = j0; j <= j1; j++) {
        var py = y0 + j * sy;
        for (var i = i0; i <= i1; i++) {
          var px = x0 + i * sx;
          var l1 = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / d;
          if (l1 < -1e-9 || l1 > 1 + 1e-9) continue;
          var l2 = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / d;
          if (l2 < -1e-9 || l2 > 1 + 1e-9) continue;
          var l3 = 1 - l1 - l2;
          if (l3 < -1e-9) continue;
          var k = j * nx + i;
          Z[k] = l1 * A.z + l2 * B.z + l3 * C.z;
          M[k] = 1;
        }
      }
    });
    return { Z: Z, M: M, nx: nx, ny: ny, x0: x0, y0: y0, sx: sx, sy: sy };
  }

  // ---------- marching squares for one level ----------
  function segmentsAt(g, lev) {
    var segs = [];
    var nx = g.nx, ny = g.ny, Z = g.Z, M = g.M;
    function ip(xa, ya, va, xb, yb, vb) {
      var t = (lev - va) / (vb - va);
      return [xa + (xb - xa) * t, ya + (yb - ya) * t];
    }
    for (var j = 0; j < ny - 1; j++) {
      for (var i = 0; i < nx - 1; i++) {
        var k00 = j * nx + i, k10 = k00 + 1, k01 = k00 + nx, k11 = k01 + 1;
        if (!(M[k00] && M[k10] && M[k01] && M[k11])) continue;   // outside the hull
        var v00 = Z[k00], v10 = Z[k10], v01 = Z[k01], v11 = Z[k11];
        var idx = (v00 > lev ? 1 : 0) | (v10 > lev ? 2 : 0) | (v11 > lev ? 4 : 0) | (v01 > lev ? 8 : 0);
        if (idx === 0 || idx === 15) continue;
        var x0 = g.x0 + i * g.sx, y0 = g.y0 + j * g.sy;
        var x1 = x0 + g.sx, y1 = y0 + g.sy;
        var B = ip(x0, y0, v00, x1, y0, v10);   // bottom
        var R = ip(x1, y0, v10, x1, y1, v11);   // right
        var T = ip(x0, y1, v01, x1, y1, v11);   // top
        var L = ip(x0, y0, v00, x0, y1, v01);   // left
        switch (idx) {
          case 1: case 14: segs.push([L, B]); break;
          case 2: case 13: segs.push([B, R]); break;
          case 3: case 12: segs.push([L, R]); break;
          case 4: case 11: segs.push([R, T]); break;
          case 6: case 9:  segs.push([B, T]); break;
          case 7: case 8:  segs.push([L, T]); break;
          case 5:  segs.push([L, T], [B, R]); break;
          case 10: segs.push([L, B], [R, T]); break;
        }
      }
    }
    return segs;
  }

  // ---------- chain segments into polylines ----------
  function chain(segs, tol) {
    var key = function (p) { return Math.round(p[0] / tol) + ',' + Math.round(p[1] / tol); };
    var ends = {};
    segs.forEach(function (s, i) {
      (ends[key(s[0])] = ends[key(s[0])] || []).push([i, 0]);
      (ends[key(s[1])] = ends[key(s[1])] || []).push([i, 1]);
    });
    var used = new Array(segs.length).fill(false), out = [];
    for (var i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      var line = [segs[i][0], segs[i][1]];
      // extend both ways
      for (var dir = 0; dir < 2; dir++) {
        for (;;) {
          var tip = dir ? line[0] : line[line.length - 1];
          var cand = ends[key(tip)] || [], nxt = -1, nend = 0;
          for (var c = 0; c < cand.length; c++) {
            if (!used[cand[c][0]]) { nxt = cand[c][0]; nend = cand[c][1]; break; }
          }
          if (nxt < 0) break;
          used[nxt] = true;
          var other = segs[nxt][1 - nend];
          if (dir) line.unshift(other); else line.push(other);
        }
      }
      if (line.length >= 2) out.push(line);
    }
    return out;
  }

  function makeContours(points, opt) {
    opt = opt || {};
    var interval = +opt.interval || 10;
    var nx = opt.grid || 320, ny = opt.grid || 320;
    var indexEvery = opt.index || 5;      // every Nth line is an index contour

    var pts = points.filter(function (p) {
      return isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
    });
    // merge coincident locations by averaging
    var seen = {};
    pts.forEach(function (p) {
      var k = p.x.toFixed(6) + ',' + p.y.toFixed(6);
      (seen[k] = seen[k] || []).push(p);
    });
    pts = Object.keys(seen).map(function (k) {
      var g = seen[k], z = 0;
      g.forEach(function (p) { z += p.z; });
      return { x: g[0].x, y: g[0].y, z: z / g.length };
    });
    if (pts.length < 3) return { type: 'FeatureCollection', features: [], stats: { points: pts.length } };

    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    var zmin = Infinity, zmax = -Infinity;
    pts.forEach(function (p) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
      if (p.z < zmin) zmin = p.z; if (p.z > zmax) zmax = p.z;
    });
    var padx = (maxx - minx) * 0.01, pady = (maxy - miny) * 0.01;
    var bbox = [minx - padx, miny - pady, maxx + padx, maxy + pady];

    // A clip ring narrows the grid to that area, so resolution concentrates where
    // it is wanted. Interpolation still uses every point, so values near the ring
    // edge remain informed by boreholes just outside it.
    var clip = opt.clip && opt.clip.length >= 3 ? opt.clip : null;
    if (clip) {
      var cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
      clip.forEach(function (c) {
        if (c[0] < cx0) cx0 = c[0]; if (c[0] > cx1) cx1 = c[0];
        if (c[1] < cy0) cy0 = c[1]; if (c[1] > cy1) cy1 = c[1];
      });
      var mx = (cx1 - cx0) * 0.02, my = (cy1 - cy0) * 0.02;
      bbox = [Math.max(bbox[0], cx0 - mx), Math.max(bbox[1], cy0 - my),
              Math.min(bbox[2], cx1 + mx), Math.min(bbox[3], cy1 + my)];
      if (!(bbox[2] > bbox[0] && bbox[3] > bbox[1])) {
        return { type: 'FeatureCollection', features: [],
                 stats: { points: pts.length, triangles: 0, levels: 0, lines: 0,
                          zmin: zmin, zmax: zmax, interval: interval, clipped: true,
                          outside: true } };
      }
    }

    var tris = delaunay(pts);
    var g = rasterise(pts, tris, nx, ny, bbox);

    var kept = 0;
    if (clip) {
      for (var j = 0; j < g.ny; j++) {
        var py = g.y0 + j * g.sy;
        for (var i = 0; i < g.nx; i++) {
          var k = j * g.nx + i;
          if (!g.M[k]) continue;
          if (inRing(g.x0 + i * g.sx, py, clip)) kept++; else g.M[k] = 0;
        }
      }
      if (!kept) {
        return { type: 'FeatureCollection', features: [],
                 stats: { points: pts.length, triangles: tris.length, levels: 0, lines: 0,
                          zmin: zmin, zmax: zmax, interval: interval, clipped: true,
                          outside: true } };
      }
    }

    // recompute the level range from what is actually inside the mask
    if (clip) {
      zmin = Infinity; zmax = -Infinity;
      for (var q = 0; q < g.Z.length; q++) {
        if (!g.M[q]) continue;
        if (g.Z[q] < zmin) zmin = g.Z[q];
        if (g.Z[q] > zmax) zmax = g.Z[q];
      }
    }

    var lo = Math.ceil(zmin / interval) * interval;
    var hi = Math.floor(zmax / interval) * interval;
    var tol = Math.min(g.sx, g.sy) / 4;
    var feats = [];
    var nLevels = 0;
    for (var lev = lo; lev <= hi + 1e-9; lev += interval) {
      var segs = segmentsAt(g, lev);
      if (!segs.length) continue;
      nLevels++;
      var lines = chain(segs, tol);
      var step = Math.round(lev / interval);
      var isIndex = indexEvery > 0 && (step % indexEvery === 0) ? 1 : 0;
      lines.forEach(function (ln) {
        if (ln.length < 3) return;
        feats.push({
          type: 'Feature',
          properties: { e: Math.round(lev * 100) / 100, ix: isIndex },
          geometry: {
            type: 'LineString',
            coordinates: ln.map(function (c) {
              return [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
            })
          }
        });
      });
    }
    return {
      type: 'FeatureCollection',
      features: feats,
      stats: {
        points: pts.length, triangles: tris.length,
        levels: nLevels, lines: feats.length,
        zmin: zmin, zmax: zmax, interval: interval,
        clipped: !!clip
      }
    };
  }

  global.makeContours = makeContours;
})(window);
