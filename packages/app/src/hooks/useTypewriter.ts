import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Progressively reveals text content with a typewriter effect.
 *
 * Detects large content jumps (> threshold) regardless of streaming state
 * and animates the reveal. Small increments (normal SSE deltas) are shown
 * immediately to preserve the natural streaming feel.
 *
 * The animation is independent of isStreaming — even when the server sends
 * complete content in one shot alongside message.completed (isStreaming=false),
 * the typewriter still runs.
 */

const TYPEWRITER_THRESHOLD = 80;
const BASE_CHARS_PER_FRAME = 25;
const ACCELERATION_FACTOR = 0.035;

interface TypewriterResult {
  displayedText: string;
  isRevealing: boolean;
}

export function useTypewriter(
  fullText: string,
  _isStreaming: boolean,
): TypewriterResult {
  const [displayedText, setDisplayedText] = useState(fullText);
  const revealedLenRef = useRef(fullText.length);
  const targetTextRef = useRef(fullText);
  const animRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);

  targetTextRef.current = fullText;

  const stopAnimation = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    isAnimatingRef.current = false;
  }, []);

  const tick = useCallback(() => {
    const target = targetTextRef.current;
    const revealed = revealedLenRef.current;
    const remaining = target.length - revealed;

    if (remaining <= 0) {
      isAnimatingRef.current = false;
      return;
    }

    const chunkSize = Math.max(
      BASE_CHARS_PER_FRAME,
      Math.ceil(remaining * ACCELERATION_FACTOR),
    );
    const newLen = Math.min(revealed + chunkSize, target.length);
    revealedLenRef.current = newLen;
    setDisplayedText(target.slice(0, newLen));

    if (newLen < target.length) {
      animRef.current = requestAnimationFrame(tick);
    } else {
      isAnimatingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Text was replaced / shrunk — snap immediately
    if (fullText.length < revealedLenRef.current) {
      stopAnimation();
      revealedLenRef.current = fullText.length;
      setDisplayedText(fullText);
      return;
    }

    const delta = fullText.length - revealedLenRef.current;
    if (delta <= 0) return;

    // Small delta: show immediately (preserves normal streaming feel)
    if (delta <= TYPEWRITER_THRESHOLD) {
      stopAnimation();
      revealedLenRef.current = fullText.length;
      setDisplayedText(fullText);
      return;
    }

    // Large delta: start animation if not already running
    if (!isAnimatingRef.current) {
      isAnimatingRef.current = true;
      animRef.current = requestAnimationFrame(tick);
    }
    // If already animating, the running tick reads targetTextRef and catches up
  }, [fullText, stopAnimation, tick]);

  useEffect(() => {
    return () => stopAnimation();
  }, [stopAnimation]);

  return {
    displayedText,
    isRevealing: displayedText.length < fullText.length,
  };
}
