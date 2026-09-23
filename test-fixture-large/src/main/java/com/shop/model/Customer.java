package com.shop.model;

import jakarta.persistence.*;

@Entity
@Table(name = "customers")
public class Customer {
    @Id @GeneratedValue private Long id;
    private String username;
    private String passwordHash;
    public Long getId() { return id; }
    public String getPasswordHash() { return passwordHash; }
}
