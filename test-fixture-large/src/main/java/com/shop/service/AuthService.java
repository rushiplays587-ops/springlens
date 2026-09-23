package com.shop.service;

import org.springframework.stereotype.Service;

@Service
public class AuthService {
    private final UserRepository userRepository;
    private final TokenStore tokenStore;

    public AuthService(UserRepository userRepository, TokenStore tokenStore) {
        this.userRepository = userRepository;
        this.tokenStore = tokenStore;
    }

    public TokenResponse authenticate(String username, String password) {
        Customer user = userRepository.findByUsername(username);
        if (user == null || !passwordMatches(password, user.getPasswordHash())) {
            throw new BadCredentialsException("Invalid credentials");
        }
        return new TokenResponse(tokenStore.issue(user));
    }

    public void revoke(String token) { tokenStore.invalidate(token); }
}
