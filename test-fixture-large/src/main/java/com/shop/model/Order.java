package com.shop.model;

import jakarta.persistence.*;

@Entity
@Table(name = "orders")
public class Order {
    @Id @GeneratedValue private Long id;
    @OneToMany private java.util.List<OrderItem> items;
    public java.util.List<OrderItem> getItems() { return items; }
}
