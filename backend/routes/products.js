import { Router } from "express";
import { products } from "../data/products.js";

const router = Router();

router.get("/", (req, res) => {
  const { type } = req.query;
  res.json(type ? products.filter((p) => p.type === type) : products);
});

export default router;
