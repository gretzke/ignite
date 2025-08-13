// Typed React-Redux hooks
// - `useAppDispatch` knows our store's dispatch type
// - `useAppSelector` knows our RootState type
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from './store';

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
