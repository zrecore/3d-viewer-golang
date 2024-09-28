package main

import (
	"io/fs"
	"main/viewer"
	"net/http"

	"github.com/gin-gonic/gin"
)

type ENTRIES struct {
}

func main() {
	router := gin.Default()
	router.LoadHTMLGlob("templates/*")
	router.Static("/assets", "./assets")

	router.GET("/", func(c *gin.Context) {
		var entries []fs.DirEntry = viewer.Load()
		c.HTML(http.StatusOK, "index.html", gin.H{
			"title":   "3D Viewer",
			"entries": entries,
		})
	})

	router.GET("/sign-in", func(c *gin.Context) {
		c.HTML(http.StatusOK, "sign-in.html", gin.H{
			"title": "3D Viewer",
		})
	})

	router.POST("/sign-in", viewer.SignIn)

	router.GET("/api/load-entries", func(c *gin.Context) {
		var entries []fs.DirEntry = viewer.Load()

		c.JSON(http.StatusOK, entries)
	})

	router.Run(":8080")
}
