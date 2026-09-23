package com.shop.service;

import org.springframework.stereotype.Component;

@Component
public class TokenStore {
    private final java.util.Map<String, Long> active = new java.util.concurrent.ConcurrentHashMap<>();

    public String issue(Customer user) {
        String token = java.util.UUID.randomUUID().toString();
        active.put(token, user.getId());
        return token;
    }

    public void invalidate(String token) { active.remove(token); }
}
