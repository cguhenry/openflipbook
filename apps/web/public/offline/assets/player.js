(function () {
  "use strict";

  var book = window.OPENFLIPBOOK_OFFLINE_BOOK;
  if (!book || !Array.isArray(book.nodes) || !book.nodes.length) {
    document.body.textContent = "缺少離線書資料。";
    return;
  }

  var byId = new Map(book.nodes.map(function (node) { return [node.id, node]; }));
  var currentId = byId.has(book.root_node_id) ? book.root_node_id : book.nodes[0].id;
  var trail = [currentId];
  var trailIndex = 0;

  var stage = document.getElementById("image-stage");
  var image = document.getElementById("page-image");
  var textLayer = document.getElementById("text-layer");
  var select = document.getElementById("page-select");
  var back = document.getElementById("back");
  var forward = document.getElementById("forward");
  var status = document.getElementById("status");
  var surface = document.getElementById("page-surface");
  var sourcesToggle = document.getElementById("sources-toggle");
  var sourcesPanel = document.getElementById("sources-panel");
  var sourcesList = document.getElementById("sources-list");

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function runTransition(update, xPct, yPct) {
    var x = xPct == null ? .5 : Math.max(0, Math.min(1, xPct));
    var y = yPct == null ? .5 : Math.max(0, Math.min(1, yPct));
    document.documentElement.style.setProperty("--origin-x", (x * 100) + "%");
    document.documentElement.style.setProperty("--origin-y", (y * 100) + "%");

    if (!reducedMotion() && typeof document.startViewTransition === "function") {
      try {
        document.startViewTransition(update);
        return;
      } catch (_) {}
    }
    document.documentElement.classList.add("no-view-transition");
    update();
    surface.classList.remove("is-entering");
    void surface.offsetWidth;
    surface.classList.add("is-entering");
    window.setTimeout(function () {
      surface.classList.remove("is-entering");
      document.documentElement.classList.remove("no-view-transition");
    }, 260);
  }

  function containRect(img) {
    var rect = img.getBoundingClientRect();
    if (!img.naturalWidth || !img.naturalHeight || !rect.width || !rect.height) return rect;
    var imageRatio = img.naturalWidth / img.naturalHeight;
    var boxRatio = rect.width / rect.height;
    var width, height, left, top;
    if (imageRatio > boxRatio) {
      width = rect.width;
      height = width / imageRatio;
      left = rect.left;
      top = rect.top + (rect.height - height) / 2;
    } else {
      height = rect.height;
      width = height * imageRatio;
      top = rect.top;
      left = rect.left + (rect.width - width) / 2;
    }
    return { left: left, top: top, width: width, height: height, right:left+width, bottom:top+height };
  }

  function pointOnSegment(x, y, ax, ay, bx, by) {
    var eps = 1e-9;
    var cross = (x-ax)*(by-ay) - (y-ay)*(bx-ax);
    if (Math.abs(cross) > eps) return false;
    var dot = (x-ax)*(bx-ax) + (y-ay)*(by-ay);
    if (dot < -eps) return false;
    var len2 = (bx-ax)*(bx-ax) + (by-ay)*(by-ay);
    return dot <= len2 + eps;
  }

  function pointInPolygon(x, y, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return false;
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var xi = polygon[i][0], yi = polygon[i][1];
      var xj = polygon[j][0], yj = polygon[j][1];
      if (pointOnSegment(x, y, xi, yi, xj, yj)) return true;
      var crosses = (yi > y) !== (yj > y);
      if (crosses) {
        var xAtY = ((xj-xi)*(y-yi))/(yj-yi)+xi;
        if (x < xAtY) inside = !inside;
      }
    }
    return inside;
  }

  function bboxContains(b, x, y) {
    return x >= b[0] && y >= b[1] && x <= b[0]+b[2] && y <= b[1]+b[3];
  }

  function distance2(b, x, y) {
    var dx = x-(b[0]+b[2]/2), dy = y-(b[1]+b[3]/2);
    return dx*dx+dy*dy;
  }

  function resolveHotspot(node, x, y) {
    var hs = Array.isArray(node.hotspots) ? node.hotspots : [];
    if (!hs.length || x < 0 || y < 0 || x > 1 || y > 1) return null;
    for (var i = 0; i < hs.length; i++) {
      if (pointInPolygon(x, y, hs[i].tap_region)) return hs[i];
    }
    for (var j = 0; j < hs.length; j++) {
      if (bboxContains(hs[j].actual_bbox, x, y)) return hs[j];
    }
    return hs.slice().sort(function (a, b) {
      return distance2(a.actual_bbox, x, y) - distance2(b.actual_bbox, x, y) ||
        String(a.id).localeCompare(String(b.id));
    })[0] || null;
  }

  function anchorClass(anchor) {
    return "anchor-" + String(anchor || "bottom-left").replace(/[^a-z-]/g, "");
  }

  function sourceId(source, index) {
    return source && source.id ? String(source.id) : "S" + (index + 1);
  }

  function safeExternalUrl(raw) {
    try {
      var parsed = new URL(String(raw || ""));
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.href
        : null;
    } catch (_) {
      return null;
    }
  }

  function renderText(node) {
    textLayer.replaceChildren();
    (node.text_blocks || []).forEach(function (block) {
      var div = document.createElement("div");
      div.className = "text-block " + anchorClass(block.anchor);
      div.dataset.role = block.role || "body";
      div.dataset.textBlockId = block.id || "";
      var span = document.createElement("span");
      span.textContent = block.text || "";
      div.appendChild(span);
      var ids = Array.isArray(block.source_ids) ? block.source_ids : [];
      var sources = Array.isArray(node.sources) ? node.sources : [];
      ids.forEach(function (id) {
        var index = sources.findIndex(function (source, sourceIndex) {
          return sourceId(source, sourceIndex) === String(id);
        });
        if (index < 0) return;
        var marker = document.createElement("sup");
        marker.className = "source-marker";
        marker.dataset.sourceId = String(id);
        marker.textContent = "[" + (index + 1) + "]";
        marker.setAttribute("aria-label", "來源 " + (index + 1));
        span.appendChild(marker);
      });
      textLayer.appendChild(div);
    });
  }

  function renderSources(node) {
    var sources = Array.isArray(node.sources) ? node.sources : [];
    sourcesList.replaceChildren();
    if (!sources.length) {
      sourcesToggle.hidden = true;
      sourcesPanel.hidden = true;
      sourcesToggle.setAttribute("aria-expanded", "false");
      return;
    }
    sourcesToggle.hidden = false;
    sourcesToggle.textContent = "來源（" + sources.length + "）";
    sources.forEach(function (source, index) {
      var item = document.createElement("li");
      var href = safeExternalUrl(source.url);
      var title = source.title || source.url || sourceId(source, index);
      if (href) {
        var link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = title;
        item.appendChild(link);
      } else {
        var label = document.createElement("span");
        label.textContent = title;
        item.appendChild(label);
      }
      if (source.snippet) {
        var snippet = document.createElement("p");
        snippet.textContent = source.snippet;
        item.appendChild(snippet);
      }
      sourcesList.appendChild(item);
    });
  }

  function render() {
    var node = byId.get(currentId);
    if (!node) return;
    if (node.image) {
      image.classList.remove("is-missing");
      image.src = node.image;
    } else {
      image.removeAttribute("src");
      image.classList.add("is-missing");
    }
    image.alt = "插圖：" + (node.title || node.query || "");
    renderText(node);
    renderSources(node);
    select.value = node.id;
    status.textContent = node.title || node.query || "";
    back.disabled = trailIndex <= 0;
    forward.disabled = trailIndex >= trail.length - 1;
    document.title = (node.title || "OpenFlipbook") + " — 離線書";
  }

  function navigate(id, options) {
    if (!byId.has(id)) return;
    options = options || {};
    runTransition(function () {
      currentId = id;
      if (options.push !== false) {
        trail = trail.slice(0, trailIndex + 1);
        trail.push(id);
        trailIndex = trail.length - 1;
      }
      render();
    }, options.xPct, options.yPct);
  }

  book.nodes.forEach(function (node) {
    var option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.title || node.query || node.id;
    select.appendChild(option);
  });

  select.addEventListener("change", function () {
    navigate(select.value, { push: true });
  });
  back.addEventListener("click", function () {
    if (trailIndex <= 0) return;
    trailIndex -= 1;
    runTransition(function () {
      currentId = trail[trailIndex];
      render();
    });
  });
  forward.addEventListener("click", function () {
    if (trailIndex >= trail.length - 1) return;
    trailIndex += 1;
    runTransition(function () {
      currentId = trail[trailIndex];
      render();
    });
  });

  sourcesToggle.addEventListener("click", function () {
    var open = sourcesPanel.hidden;
    sourcesPanel.hidden = !open;
    sourcesToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  image.addEventListener("error", function () {
    image.classList.add("is-missing");
    status.textContent = "此頁的圖片資產無法讀取";
  });

  stage.addEventListener("click", function (event) {
    var node = byId.get(currentId);
    if (!node || image.classList.contains("is-missing")) return;
    var r = containRect(image);
    if (event.clientX < r.left || event.clientX > r.right ||
        event.clientY < r.top || event.clientY > r.bottom) return;
    var x = (event.clientX-r.left)/r.width;
    var y = (event.clientY-r.top)/r.height;
    var hit = resolveHotspot(node, x, y);
    if (!hit) return;
    if (!hit.target_node_id || !byId.has(hit.target_node_id)) {
      status.textContent = "「" + hit.label + "」尚未在匯出前探索";
      return;
    }
    navigate(hit.target_node_id, { push: true, xPct: x, yPct: y });
  });

  window.addEventListener("keydown", function (event) {
    if (event.key === "ArrowLeft") back.click();
    if (event.key === "ArrowRight") forward.click();
  });

  // Exposed only for zero-browser/static tests; no network/runtime dependency.
  window.__OPENFLIPBOOK_OFFLINE__ = {
    resolveHotspot: resolveHotspot,
    containRect: containRect,
    safeExternalUrl: safeExternalUrl,
  };
  render();
})();
