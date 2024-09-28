package viewer

import (
	"io/fs"
	"log"
	"os"

	"github.com/gin-gonic/gin"
)

func Load() []fs.DirEntry {
	// Load the directory listing of /assets/stl
	entries, err := os.ReadDir("./assets/stl/")
	if err != nil {
		log.Fatal(err)
	}

	return entries
}

func SignIn(c *gin.Context) {

}
