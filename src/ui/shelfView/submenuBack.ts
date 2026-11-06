import { useCallback, useEffect, useRef } from "react";

export interface ShelfSubmenuBackProps {
  registerSubmenuBackHandler?: (handler: (() => boolean) | null) => void;
  onSubmenuBackActiveChange?: (active: boolean) => void;
}

export function useShelfSubmenuBack(
  open: boolean,
  close: () => void,
  props: ShelfSubmenuBackProps,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const handler = useCallback((): boolean => {
    closeRef.current();
    return true;
  }, []);
  useEffect(() => {
    if (!open) return;
    props.registerSubmenuBackHandler?.(handler);
    props.onSubmenuBackActiveChange?.(true);
    return () => {
      props.registerSubmenuBackHandler?.(null);
      props.onSubmenuBackActiveChange?.(false);
    };
  }, [handler, open, props.onSubmenuBackActiveChange, props.registerSubmenuBackHandler]);
}
