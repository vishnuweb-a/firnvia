import { createContext, useContext, useEffect, useReducer } from "react";

const CartContext = createContext(null);
const STORAGE_KEY = "firvanra_cart";

function reducer(state, action) {
  switch (action.type) {
    case "add": {
      const existing = state.find((i) => i.id === action.product.id);
      if (existing)
        return state.map((i) =>
          i.id === action.product.id ? { ...i, qty: i.qty + 1 } : i
        );
      return [...state, { ...action.product, qty: 1 }];
    }
    case "remove":
      return state.filter((i) => i.id !== action.id);
    case "qty":
      return state
        .map((i) =>
          i.id === action.id ? { ...i, qty: Math.max(0, action.qty) } : i
        )
        .filter((i) => i.qty > 0);
    case "clear":
      return [];
    default:
      return state;
  }
}

function init() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }) {
  const [items, dispatch] = useReducer(reducer, [], init);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  const value = {
    items,
    count: items.reduce((s, i) => s + i.qty, 0),
    total: items.reduce((s, i) => s + i.price * i.qty, 0),
    add: (product) => dispatch({ type: "add", product }),
    remove: (id) => dispatch({ type: "remove", id }),
    setQty: (id, qty) => dispatch({ type: "qty", id, qty }),
    clear: () => dispatch({ type: "clear" }),
  };
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
