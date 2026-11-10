// 검증 전용 최소 타입 (이 환경에 @types/react 가 없어 직접 작성. 실제 프로젝트는 @types/react 사용)
declare module "react" {
  export type ReactNode = string | number | boolean | null | undefined | ReactElement | ReactNode[];
  export interface ReactElement { type: unknown; props: unknown; key: string | null }
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(cb: T, deps: readonly unknown[]): T;
  export interface RefObject<T> { current: T }
  export function useRef<T>(initial: T): RefObject<T>;
  export function useRef<T>(initial: T | null): RefObject<T | null>;
  export const Suspense: (p: { fallback: ReactNode; children?: ReactNode }) => ReactElement;
  export interface SyntheticEvent<E = Element, N = Event> { target: EventTarget | null; currentTarget: E; nativeEvent: N; preventDefault(): void; stopPropagation(): void }
  export interface MouseEvent<E = Element> extends SyntheticEvent<E, globalThis.MouseEvent> { clientX: number; clientY: number; button: number; ctrlKey: boolean; relatedTarget: EventTarget | null }
  export interface PointerEvent<E = Element> extends MouseEvent<E> { pointerId: number }
  export interface WheelEvent<E = Element> extends MouseEvent<E> { deltaY: number }
  export interface KeyboardEvent<E = Element> extends SyntheticEvent<E> { key: string; ctrlKey: boolean }
  export interface FormEvent<E = Element> extends SyntheticEvent<E> {}
  export interface DragEvent<E = Element> extends MouseEvent<E> { dataTransfer: DataTransfer }
  export interface ChangeEvent<E = Element> extends SyntheticEvent<E> { target: EventTarget & E }
}
declare namespace JSX {
  type Element = import("react").ReactElement;
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number }
  type FormEl = HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
  type R = typeof import("react");
  interface IntrinsicProps {
    [attr: string]: unknown;
    ref?: import("react").RefObject<any>;
    onChange?(e: import("react").ChangeEvent<FormEl>): void;
    onClick?(e: import("react").MouseEvent<HTMLElement>): void;
    onDoubleClick?(e: import("react").MouseEvent<HTMLDivElement>): void;
    onContextMenu?(e: import("react").MouseEvent<HTMLElement>): void;
    onSubmit?(e: import("react").FormEvent<HTMLFormElement>): void;
    onDragOver?(e: import("react").DragEvent<HTMLElement>): void;
    onDragLeave?(e: import("react").DragEvent<HTMLElement>): void;
    onDrop?(e: import("react").DragEvent<HTMLElement>): void;
    onWheel?(e: import("react").WheelEvent<HTMLElement>): void;
    onKeyDown?(e: import("react").KeyboardEvent<any>): void;
    onPointerDown?(e: import("react").PointerEvent<HTMLDivElement>): void;
    onPointerMove?(e: import("react").PointerEvent<HTMLDivElement>): void;
    onPointerUp?(e: import("react").PointerEvent<HTMLDivElement>): void;
    onPointerLeave?(e: import("react").PointerEvent<HTMLDivElement>): void;
  }
  interface IntrinsicElements { [name: string]: IntrinsicProps }
}
