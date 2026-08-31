// frontend/src/components/Carousel.jsx

import { useEffect, useRef, useState } from 'react';
import { fetchBoard } from '../api.js';
import { Receipt } from './Receipt.jsx';

const PREVIEW_SIZE = 8;

/** @param {{ onPrint: (message: any) => void, reloadToken?: number }} props */
export function Carousel({ onPrint, reloadToken = 0 }) {
  const trackRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [items, setItems] = useState(/** @type {any[]} */ ([]));
  const [edges, setEdges] = useState({ atStart: true, atEnd: true });

  useEffect(() => {
    let cancelled = false;

    fetchBoard({ limit: PREVIEW_SIZE })
      .then((data) => {
        if (!cancelled) setItems(data.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Native overflow scrolling drives the carousel, so touch, trackpad and keyboard all
  // work for free; the arrows only nudge it. Re-implementing that by hand would mean
  // re-implementing every one of those behaviours badly.
  function syncEdges() {
    const track = trackRef.current;
    if (!track) return;

    const maxScroll = track.scrollWidth - track.clientWidth;
    setEdges({ atStart: track.scrollLeft <= 1, atEnd: track.scrollLeft >= maxScroll - 1 });
  }

  useEffect(syncEdges, [items]);

  /** @param {1 | -1} direction */
  function nudge(direction) {
    const track = trackRef.current;
    if (!track) return;

    const cards = /** @type {HTMLElement[]} */ (Array.from(track.children));
    const step = cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : track.clientWidth;
    track.scrollBy({ left: direction * step, behavior: 'smooth' });
  }

  if (items.length === 0) return null;

  return (
    <section className="carousel">
      <div className="carousel__head">
        <h2>Ultimi in bacheca</h2>
        <div className="carousel__nav">
          <button className="ghost" onClick={() => nudge(-1)} disabled={edges.atStart} aria-label="Scontrini precedenti">
            ←
          </button>
          <button className="ghost" onClick={() => nudge(1)} disabled={edges.atEnd} aria-label="Scontrini successivi">
            →
          </button>
        </div>
      </div>

      <div
        className="carousel__track"
        ref={trackRef}
        onScroll={syncEdges}
        tabIndex={0}
        role="region"
        aria-label="Ultimi messaggi approvati"
      >
        {items.map((message) => (
          <div className="carousel__slide" key={message.id}>
            <Receipt message={message} onPrint={onPrint} />
          </div>
        ))}
      </div>
    </section>
  );
}
