package main

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zrecore/3d-viewer-golang/auth"
	"github.com/zrecore/3d-viewer-golang/server"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("fatal: %v", err)
	}
}

func run() error {
	cfg, err := server.LoadConfig(os.Getenv)
	if err != nil {
		return err
	}
	a, err := auth.New(cfg.Auth)
	if err != nil {
		return err
	}
	if a.Enabled() {
		log.Printf("OIDC login enabled (issuer %s)", cfg.Auth.Issuer)
	} else {
		log.Printf("OIDC_ISSUER is not set: uploads are disabled")
	}
	if err := os.MkdirAll(cfg.ModelsDir(), 0o755); err != nil {
		log.Printf("warning: cannot create models directory %s: %v", cfg.ModelsDir(), err)
	}

	router, err := server.New(cfg, a)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("listening on %s", cfg.Addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		stop()
		log.Printf("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
