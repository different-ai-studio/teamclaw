/// <reference types="vite/client" />

declare module '*.css' {
  const content: string
  export default content
}

// Web Speech API (SpeechRecognition) - not in standard lib.dom.d.ts
interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}
declare var SpeechRecognition: { new (): SpeechRecognitionInstance };
declare var webkitSpeechRecognition: { new (): SpeechRecognitionInstance };
interface Window {
  SpeechRecognition?: typeof SpeechRecognition;
  webkitSpeechRecognition?: typeof webkitSpeechRecognition;
}
