package com.shop.model;

import jakarta.persistence.*;

@Entity
public class Product {
    @Id @GeneratedValue private Long id;
    private String sku;
    private int stock;
    public int getStock() { return stock; }
    public void setStock(int stock) { this.stock = stock; }
}
